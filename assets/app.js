/**
 * Map Tools — application logic.
 *
 * Three independent tools share one page:
 *   - Geometry Extractor: draw on a map, edit vertices, export as Array / WKT / GeoJSON.
 *   - Geometry Viewer:    paste Array / WKT / GeoJSON (auto-detected), inspect it on a map
 *                         and convert it between the three formats.
 *   - Coordinate Converter: convert a single coordinate between EPSG:3857 / EPSG:4326.
 *
 * Depends on globals provided by the vendored plugins: jQuery ($), OpenLayers (ol), proj4.
 */
$(function () {
    'use strict';

    /* ----------------------------------------------------------------- *
     * Constants
     * ----------------------------------------------------------------- */
    const PROJ = { MERCATOR: 'EPSG:3857', WGS84: 'EPSG:4326' };
    const MAP_CENTER = [53.584972499936065, 32.24674047057724]; // Iran (lon, lat)
    const DEFAULT_ZOOM = 5;
    const FIT_OPTIONS = { padding: [50, 50, 50, 50], maxZoom: 18, duration: 400 };
    // Output precision: ~1 mm in degrees (4326) and ~0.1 mm in meters (3857).
    const OUTPUT_DECIMALS = { 'EPSG:3857': 4, 'EPSG:4326': 8 };

    // CARTO Voyager basemap. This OpenLayers build doesn't expand the {r} retina
    // token, so resolve it ourselves from the device pixel ratio (@2x on HiDPI).
    const HIDPI = window.devicePixelRatio > 1;
    const BASE_TILE_URL =
        'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}' + (HIDPI ? '@2x' : '') + '.png';
    const BASE_TILE_ATTRIBUTION =
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '© <a href="https://carto.com/attributions">CARTO</a>';

    /* ----------------------------------------------------------------- *
     * Shared state
     * ----------------------------------------------------------------- */
    const $inputError = $('#input-error');
    const $outputSection = $('#output-section');
    const $output = $('#output');

    const extractorSource = new ol.source.Vector();
    const viewerSource = new ol.source.Vector();
    const wktFormat = new ol.format.WKT();
    const geojsonFormat = new ol.format.GeoJSON();

    /* ----------------------------------------------------------------- *
     * UI helpers
     * ----------------------------------------------------------------- */
    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function showError(message) {
        $inputError.html('<span class="font-semibold"> Error: </span> ' + escapeHtml(message)).show();
    }

    function hideError() {
        $inputError.hide();
    }

    function showOutput(html) {
        $output.html(html);
        $outputSection.show();
    }

    function hideOutput() {
        $outputSection.hide();
    }

    function resetUI() {
        hideError();
        hideOutput();
        extractorSource.clear();
        viewerSource.clear();
    }

    // A <pre> block with a hover Copy button. `text` is escaped, so any
    // user-supplied content (e.g. GeoJSON properties) renders inert.
    function copyBlock(text, language) {
        return '<div class="relative group mt-2">' +
            '<button class="copy-btn absolute right-2 top-2 text-sm bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded border">Copy</button>' +
            '<pre class="bg-gray-100 p-4 rounded overflow-auto"><code class="language-' + language + '">' +
            escapeHtml(text) + '</code></pre></div>';
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        // Fallback for non-secure contexts.
        return new Promise(function (resolve, reject) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
            } finally {
                ta.remove();
            }
        });
    }

    /* ----------------------------------------------------------------- *
     * Map / layer factory
     * ----------------------------------------------------------------- */
    function vectorStyle() {
        return new ol.style.Style({
            fill: new ol.style.Fill({ color: 'rgba(71,65,65,0.2)' }),
            stroke: new ol.style.Stroke({ color: '#1C274C', width: 2 }),
            image: new ol.style.Circle({
                radius: 5,
                fill: new ol.style.Fill({ color: '#1C274C' })
            })
        });
    }

    function createMap(target, source) {
        const map = new ol.Map({
            target: target,
            layers: [
                new ol.layer.Tile({
                    source: new ol.source.XYZ({
                        url: BASE_TILE_URL,
                        attributions: BASE_TILE_ATTRIBUTION,
                        // Request tiles with CORS so OpenLayers' canvas stays untainted.
                        // CARTO serves Access-Control-Allow-Origin: *.
                        crossOrigin: 'anonymous',
                        tilePixelRatio: HIDPI ? 2 : 1,
                        maxZoom: 20
                    })
                }),
                new ol.layer.Vector({ source: source, style: vectorStyle() })
            ],
            view: new ol.View({
                center: ol.proj.fromLonLat(MAP_CENTER),
                zoom: DEFAULT_ZOOM,
                extent: ol.proj.get(PROJ.MERCATOR).getExtent()
            })
        });
        map.addControl(new ol.control.ScaleLine());
        map.addControl(new ol.control.MousePosition({
            projection: PROJ.WGS84,
            coordinateFormat: ol.coordinate.createStringXY(5),
            placeholder: ''
        }));
        return map;
    }

    /* ----------------------------------------------------------------- *
     * Geometry helpers
     * ----------------------------------------------------------------- */

    // Build an OL geometry from a plain coordinate array, inferring the type
    // from its nesting depth: [x,y] Point, [[x,y]] LineString, [[[x,y]]] Polygon,
    // [[[[x,y]]]] MultiPolygon.
    function geometryFromArray(coordinates) {
        if (!Array.isArray(coordinates)) throw new Error('Not an array');
        if (typeof coordinates[0] === 'number') return new ol.geom.Point(coordinates);
        if (typeof coordinates[0][0] === 'number') return new ol.geom.LineString(coordinates);
        if (typeof coordinates[0][0][0] === 'number') return new ol.geom.Polygon(coordinates);
        if (typeof coordinates[0][0][0][0] === 'number') return new ol.geom.MultiPolygon(coordinates);
        throw new Error('Unsupported geometry format');
    }

    function roundDeep(value, decimals) {
        const factor = Math.pow(10, decimals);
        if (typeof value === 'number') return Math.round(value * factor) / factor;
        return value.map(function (v) { return roundDeep(v, decimals); });
    }

    // Rounds a geometry's coordinates in place. GeometryCollections are left
    // untouched (no uniform get/setCoordinates) — they just serialize unrounded.
    function roundGeometry(geometry, decimals) {
        if (geometry.getType() === 'GeometryCollection') return;
        geometry.setCoordinates(roundDeep(geometry.getCoordinates(), decimals));
    }

    // Clone features and re-project their geometries from the map projection
    // (Web Mercator) into the requested output projection, rounded for display.
    function transformedClones(features, targetProjection) {
        return features.map(function (feature) {
            const clone = feature.clone();
            const geometry = clone.getGeometry();
            geometry.transform(PROJ.MERCATOR, targetProjection);
            roundGeometry(geometry, OUTPUT_DECIMALS[targetProjection] || 6);
            return clone;
        });
    }

    // Collapses coordinate pairs onto one line for readability.
    function collapsePairs(json) {
        return json.replace(/(-?\d),\n\s*(-?\d)/g, '$1, $2');
    }

    function toArrayText(features) {
        if (features.length !== 1) return null;
        const geometry = features[0].getGeometry();
        if (geometry.getType() === 'GeometryCollection') return null;
        return collapsePairs(JSON.stringify(geometry.getCoordinates(), null, 2));
    }

    function toWktText(features) {
        const wkt = features.length === 1
            ? wktFormat.writeFeature(features[0])
            : wktFormat.writeFeatures(features);
        return wkt.replaceAll(',', ',\n');
    }

    function toGeoJsonText(features) {
        const obj = features.length === 1
            ? geojsonFormat.writeFeatureObject(features[0])
            : geojsonFormat.writeFeaturesObject(features);
        return collapsePairs(JSON.stringify(obj, null, 2));
    }

    /* ----------------------------------------------------------------- *
     * Measurements (geometry must be in the map projection, EPSG:3857 —
     * ol.sphere's default)
     * ----------------------------------------------------------------- */
    function formatLength(meters) {
        return meters >= 1000 ? (meters / 1000).toFixed(2) + ' km' : meters.toFixed(1) + ' m';
    }

    function formatArea(sqMeters) {
        if (sqMeters >= 1e6) return (sqMeters / 1e6).toFixed(2) + ' km²';
        if (sqMeters >= 1e4) return (sqMeters / 1e4).toFixed(2) + ' ha';
        return sqMeters.toFixed(1) + ' m²';
    }

    function countVertices(geometry) {
        if (geometry.getType() === 'GeometryCollection') {
            return geometry.getGeometries().reduce(function (n, g) { return n + countVertices(g); }, 0);
        }
        const count = function (coords) {
            if (!coords.length) return 0;
            if (typeof coords[0] === 'number') return 1;
            return coords.reduce(function (n, c) { return n + count(c); }, 0);
        };
        return count(geometry.getCoordinates());
    }

    function perimeterOf(geometry) {
        let total = 0;
        const polygons = geometry.getType() === 'MultiPolygon' ? geometry.getPolygons() : [geometry];
        polygons.forEach(function (polygon) {
            polygon.getLinearRings().forEach(function (ring) {
                total += ol.sphere.getLength(new ol.geom.LineString(ring.getCoordinates()));
            });
        });
        return total;
    }

    function geometryStats(geometry) {
        const type = geometry.getType();
        const stats = [];
        if (type === 'Point') {
            const lonLat = ol.proj.toLonLat(geometry.getCoordinates());
            stats.push('Lon/Lat: ' + lonLat[0].toFixed(6) + ', ' + lonLat[1].toFixed(6));
        } else if (type === 'LineString' || type === 'MultiLineString') {
            stats.push('Length: ' + formatLength(ol.sphere.getLength(geometry)));
        } else if (type === 'Polygon' || type === 'MultiPolygon') {
            stats.push('Area: ' + formatArea(ol.sphere.getArea(geometry)));
            stats.push('Perimeter: ' + formatLength(perimeterOf(geometry)));
        }
        stats.push('Vertices: ' + countVertices(geometry));
        return stats;
    }

    function statsRowHtml(geometry) {
        return '<div class="flex flex-wrap gap-2 mt-1">' + geometryStats(geometry).map(function (s) {
            return '<span class="inline-block bg-slate-100 text-slate-600 text-xs font-medium px-2 py-1 rounded">' +
                escapeHtml(s) + '</span>';
        }).join('') + '</div>';
    }

    /* ----------------------------------------------------------------- *
     * Global wiring (copy buttons, tab switches, clear buttons)
     * ----------------------------------------------------------------- */

    // The output (with its copy button) is rendered dynamically, so delegate.
    $(document).on('click', '.copy-btn', function () {
        const button = this;
        const text = button.nextElementSibling.innerText;
        copyText(text).then(function () {
            button.innerText = 'Copied!';
            setTimeout(function () { button.innerText = 'Copy'; }, 1500);
        }).catch(function () {
            button.innerText = 'Copy failed';
            setTimeout(function () { button.innerText = 'Copy'; }, 1500);
        });
    });

    $('.tab-link').on('click', resetUI);

    $('.clear-map').on('click', function () {
        extractorSource.clear();
        viewerSource.clear();
        hideOutput();
    });

    const tabList = document.querySelector('[role="tablist"]');
    const tabIndicator = document.querySelector('.tab-indicator');

    function positionTabIndicator() {
        const active = document.querySelector('.tab-link.active');
        if (!tabList || !tabIndicator || !active) return;
        const tab = active.getBoundingClientRect();
        const list = tabList.getBoundingClientRect();
        tabIndicator.style.width = tab.width + 'px';
        tabIndicator.style.transform = 'translateX(' + (tab.left - list.left) + 'px)';
    }

    if (tabList && tabIndicator) {
        let scheduled = null;
        const reposition = function () {
            if (scheduled) cancelAnimationFrame(scheduled);
            scheduled = requestAnimationFrame(positionTabIndicator);
        };
        // Style/font load reflow that doesn't change the viewport.
        new ResizeObserver(reposition).observe(tabList);
        // Viewport changes: window resize and device rotation.
        $(window).on('resize', reposition);
        // Realign after david-ai updates the active tab on click.
        $('.tab-link').on('click', reposition);
        // Final correction once everything (incl. david-ai's own init) has settled.
        $(window).on('load', function () { setTimeout(positionTabIndicator, 400); });
    }

    /* ================================================================= *
     * Geometry Extractor
     * ================================================================= */
    function initExtractor() {
        const map = createMap('extractor-map', extractorSource);
        const drawTypeSelector = document.getElementById('draw-type-selector');
        const projectionSelector = document.getElementById('map-projection');
        const exportTypeSelector = document.getElementById('export-type');

        const bboxStyle = new ol.style.Style({
            stroke: new ol.style.Stroke({ color: 'red', width: 2, lineDash: [6, 4] }),
            fill: new ol.style.Fill({ color: 'rgba(255, 0, 0, 0.1)' })
        });

        // Vertex editing for the drawn feature. Disabled for BBox results,
        // where dragging a corner would break the rectangle invariant.
        const modify = new ol.interaction.Modify({ source: extractorSource });
        map.addInteraction(modify);
        modify.on('modifyend', function () { renderOutput(); });

        let drawInteraction = null;
        let lastFeature = null;
        let lastType = null;

        function setDrawType(type) {
            if (drawInteraction) {
                map.removeInteraction(drawInteraction);
            }
            // Intentionally created without a `source`: we add the finished feature
            // ourselves. This lets BBox replace the free-form sketch with its bounding
            // box instead of leaving both geometries on the map.
            drawInteraction = new ol.interaction.Draw({
                type: type === 'BBox' ? 'Polygon' : type
            });
            drawInteraction.on('drawend', function (event) {
                onDrawEnd(type, event.feature);
            });
            map.addInteraction(drawInteraction);
        }

        function onDrawEnd(type, feature) {
            extractorSource.clear();
            let result = feature;
            if (type === 'BBox') {
                const extent = feature.getGeometry().getExtent();
                result = new ol.Feature(ol.geom.Polygon.fromExtent(extent));
                result.setStyle(bboxStyle);
            }
            extractorSource.addFeature(result);
            lastFeature = result;
            lastType = type;
            modify.setActive(type !== 'BBox');
            renderOutput();
        }

        // Renders the output for the most recently drawn feature using the current
        // projection/export selections. Uses the stored draw type (not the live
        // selector) so changing the selector after drawing can't mislabel it.
        function renderOutput() {
            if (!lastFeature) return;

            const targetProjection = projectionSelector.value;
            const exportType = exportTypeSelector.value;
            const clones = transformedClones([lastFeature], targetProjection);

            let text, language;
            if (exportType === 'wkt') {
                text = toWktText(clones);
                language = 'wkt';
            } else if (exportType === 'geojson') {
                text = toGeoJsonText(clones);
                language = 'json';
            } else {
                text = toArrayText(clones);
                language = 'json';
            }

            showOutput(
                '<h3 class="text-xl text-[#1C274C] font-bold mb-1">Drawn Geometry (' +
                    escapeHtml(lastType) + ' in ' + escapeHtml(targetProjection) + ')</h3>' +
                statsRowHtml(lastFeature.getGeometry()) +
                copyBlock(text, language)
            );
        }

        drawTypeSelector.addEventListener('change', function () {
            setDrawType(drawTypeSelector.value);
        });
        projectionSelector.addEventListener('change', function () { renderOutput(); });
        exportTypeSelector.addEventListener('change', function () { renderOutput(); });

        setDrawType(drawTypeSelector.value);

        // Drawing keyboard shortcuts: Esc cancels the sketch, Backspace removes
        // the last placed vertex. Ignored while typing in a form field.
        $(document).on('keydown', function (e) {
            if (e.target.closest && e.target.closest('input, textarea, select')) return;
            if (!drawInteraction) return;
            if (e.key === 'Escape') {
                drawInteraction.abortDrawing();
            } else if (e.key === 'Backspace') {
                drawInteraction.removeLastPoint();
                e.preventDefault();
            }
        });

        // --- Location search (Nominatim) --------------------------------
        const $searchInput = $('#map-search-input');
        const $searchResults = $('#map-search-results');
        let searchTimer = null;
        let searchController = null;

        function runSearch(query) {
            if (searchController) searchController.abort();
            searchController = new AbortController();
            fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' +
                    encodeURIComponent(query), { signal: searchController.signal })
                .then(function (r) { return r.json(); })
                .then(renderSearchResults)
                .catch(function (err) {
                    if (err.name !== 'AbortError') console.error(err);
                });
        }

        function renderSearchResults(items) {
            $searchResults.empty();
            if (!items.length) {
                $('<li class="px-3 py-2 text-slate-400">No results</li>').appendTo($searchResults);
            } else {
                items.forEach(function (item) {
                    // .text() keeps Nominatim's display_name inert (no HTML injection).
                    $('<li class="px-3 py-2 cursor-pointer hover:bg-slate-50 border-t border-slate-100 first:border-t-0">')
                        .text(item.display_name)
                        .attr('data-bbox', item.boundingbox.join(','))
                        .appendTo($searchResults);
                });
            }
            $searchResults.removeClass('hidden');
        }

        $searchInput.on('input', function () {
            clearTimeout(searchTimer);
            const query = this.value.trim();
            if (query.length < 3) {
                $searchResults.addClass('hidden');
                return;
            }
            searchTimer = setTimeout(function () { runSearch(query); }, 400);
        });

        $searchInput.on('keydown', function (e) {
            if (e.key === 'Enter') {
                clearTimeout(searchTimer);
                const query = this.value.trim();
                if (query.length >= 2) runSearch(query);
            } else if (e.key === 'Escape') {
                $searchResults.addClass('hidden');
            }
        });

        $searchResults.on('click', 'li[data-bbox]', function () {
            // Nominatim bounding box order: [south, north, west, east].
            const b = this.getAttribute('data-bbox').split(',').map(Number);
            const extent = ol.proj.transformExtent([b[2], b[0], b[3], b[1]], PROJ.WGS84, PROJ.MERCATOR);
            map.getView().fit(extent, { duration: 600, maxZoom: 16, padding: [40, 40, 40, 40] });
            $searchResults.addClass('hidden');
        });

        $(document).on('click', function (e) {
            if (!e.target.closest || !e.target.closest('#map-search')) {
                $searchResults.addClass('hidden');
            }
        });

        return {
            map: map,
            source: extractorSource,
            modify: modify,
            getDraw: function () { return drawInteraction; }
        };
    }

    /* ================================================================= *
     * Geometry Viewer
     * ================================================================= */
    function initViewer() {
        const map = createMap('viewer-map', viewerSource);
        const viewProjection = map.getView().getProjection();

        function detectFormat(input) {
            if (input.startsWith('{')) return 'geojson';
            if (input.startsWith('[')) return 'array';
            return 'wkt';
        }

        // Coordinates that all fit within lon/lat bounds are almost certainly
        // EPSG:4326 — Web Mercator values within ±180 m / ±90 m of the origin
        // (middle of the Gulf of Guinea) don't occur in practice.
        function detectProjection(features) {
            const withinLonLat = features.every(function (feature) {
                const e = feature.getGeometry().getExtent();
                return e[0] >= -180 && e[2] <= 180 && e[1] >= -90 && e[3] <= 90;
            });
            return withinLonLat ? PROJ.WGS84 : PROJ.MERCATOR;
        }

        function renderViewerOutput(features, dataProjection) {
            const clones = transformedClones(features, dataProjection);
            const blocks = [];
            const arrayText = toArrayText(clones);
            if (arrayText) blocks.push({ label: 'Array', language: 'json', text: arrayText });
            blocks.push({ label: 'WKT', language: 'wkt', text: toWktText(clones) });
            blocks.push({ label: 'GeoJSON', language: 'json', text: toGeoJsonText(clones) });

            const shown = features.slice(0, 10);
            const statsHtml = shown.map(function (feature, i) {
                return '<div class="mt-2"><span class="text-slate-500 text-xs font-semibold">' +
                    escapeHtml(feature.getGeometry().getType()) +
                    (features.length > 1 ? ' #' + (i + 1) : '') + '</span>' +
                    statsRowHtml(feature.getGeometry()) + '</div>';
            }).join('') + (features.length > 10
                ? '<p class="text-xs text-slate-400 mt-1">+' + (features.length - 10) + ' more features</p>'
                : '');

            showOutput(
                '<h3 class="text-xl text-[#1C274C] font-bold mb-1">Geometry Info (' +
                    features.length + ' feature' + (features.length > 1 ? 's' : '') + ', ' +
                    escapeHtml(dataProjection) + ')</h3>' +
                statsHtml +
                blocks.map(function (b) {
                    return '<h4 class="text-sm text-[#1C274C] font-bold mt-4">' + b.label + '</h4>' +
                        copyBlock(b.text, b.language);
                }).join('')
            );
        }

        $('#show-viewer-map').on('click', function () {
            const input = $('#input-geometry').val().trim();
            const typeSelection = $('#viewer-type-selector').val();
            const projSelection = $('#viewer-projection-selector').val();

            hideError();
            if (!input) {
                showError('Please enter a geometry!');
                return;
            }
            try {
                const format = typeSelection === 'auto' ? detectFormat(input) : typeSelection;
                let features;
                if (format === 'geojson') {
                    features = geojsonFormat.readFeatures(input);
                } else if (format === 'wkt') {
                    features = [wktFormat.readFeature(input)];
                } else {
                    features = [new ol.Feature(geometryFromArray(JSON.parse(input)))];
                }
                features = features.filter(function (f) { return f && f.getGeometry(); });
                if (!features.length) throw new Error('No geometry found');

                const dataProjection = projSelection === 'auto'
                    ? detectProjection(features)
                    : projSelection;
                features.forEach(function (f) {
                    f.getGeometry().transform(dataProjection, viewProjection);
                });

                viewerSource.clear();
                viewerSource.addFeatures(features);
                map.getView().fit(viewerSource.getExtent(), FIT_OPTIONS);
                renderViewerOutput(features, dataProjection);
            } catch (e) {
                console.error(e);
                showError('Please enter valid geometry!');
            }
        });

        return { map: map, source: viewerSource };
    }

    /* ================================================================= *
     * Coordinate Converter
     * ================================================================= */
    function initConverter() {
        // Two numbers separated by a comma. Each may be an integer or decimal,
        // optionally signed, with flexible spacing around the comma.
        const COORD_RE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

        function convert() {
            const input = $('#input-coordinates').val().trim();
            let sourceProjection = $('#projection-selector').val();

            hideError();

            const match = input.match(COORD_RE);
            if (!match) {
                showError('Please enter valid coordinates!');
                hideOutput();
                return;
            }

            const x = parseFloat(match[1]);
            const y = parseFloat(match[2]);

            if (sourceProjection === 'auto') {
                sourceProjection = (Math.abs(x) <= 180 && Math.abs(y) <= 90)
                    ? PROJ.WGS84
                    : PROJ.MERCATOR;
            }
            if (sourceProjection === PROJ.WGS84 && (x < -180 || x > 180 || y < -90 || y > 90)) {
                showError('Longitude must be between -180 and 180, and latitude between -90 and 90.');
                hideOutput();
                return;
            }

            const targetProjection = sourceProjection === PROJ.WGS84 ? PROJ.MERCATOR : PROJ.WGS84;
            const result = proj4(sourceProjection, targetProjection, [x, y]);
            const decimals = OUTPUT_DECIMALS[targetProjection] || 6;
            const rx = result[0].toFixed(decimals);
            const ry = result[1].toFixed(decimals);
            const labels = targetProjection === PROJ.WGS84 ? ['Longitude', 'Latitude'] : ['X', 'Y'];

            showOutput(
                '<h3 class="text-xl text-[#1C274C] font-bold mb-1">' +
                    escapeHtml(sourceProjection) + ' → ' + escapeHtml(targetProjection) + '</h3>' +
                '<p class="text-sm mt-1"><b>' + labels[0] + ':</b> ' + rx +
                    ' &nbsp; <b>' + labels[1] + ':</b> ' + ry + '</p>' +
                copyBlock(rx + ', ' + ry, 'text')
            );
        }

        $('#convert-button').on('click', convert);
        $('#input-coordinates').on('keydown', function (e) {
            if (e.key === 'Enter') convert();
        });
    }

    window.mapTools = {
        extractor: initExtractor(),
        viewer: initViewer()
    };
    initConverter();
});
