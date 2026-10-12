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

    // Esri World Light Gray Canvas basemap: minimal, and needs no API key. The base
    // service has only land/water and country names; city and street names come from
    // the separate Reference service, drawn on top. Esri orders tiles as {z}/{y}/{x};
    // native tiles stop at z16 in many regions (deeper levels return "Map data not yet
    // available"), so OpenLayers upscales past that.
    const BASE_TILE_URLS = ['World_Light_Gray_Base', 'World_Light_Gray_Reference'].map(function (service) {
        return 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/' + service + '/MapServer/tile/{z}/{y}/{x}';
    });
    const BASE_TILE_MAX_ZOOM = 16;

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

    // A <pre> block with Copy and (optionally) Download buttons. `text` is
    // escaped, so any user-supplied content (e.g. GeoJSON properties) renders
    // inert. Passing `downloadName` adds a button that saves the block as a file.
    function copyBlock(text, language, downloadName) {
        const downloadBtn = downloadName
            ? '<button class="download-btn text-sm bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded border" ' +
                'data-filename="' + escapeHtml(downloadName) + '">Download</button>'
            : '';
        return '<div class="relative group mt-2">' +
            '<div class="absolute right-2 top-2 flex gap-1">' + downloadBtn +
            '<button class="copy-btn text-sm bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded border">Copy</button>' +
            '</div>' +
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

    // Triggers a client-side download of `text` as a file named `filename`.
    function downloadText(filename, text) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Revoke once the click has been processed so the download isn't cancelled.
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
            layers: BASE_TILE_URLS.map(function (url) {
                return new ol.layer.Tile({
                    source: new ol.source.XYZ({
                        url: url,
                        // Request tiles with CORS so OpenLayers' canvas stays untainted.
                        // Esri serves Access-Control-Allow-Origin: *.
                        crossOrigin: 'anonymous',
                        maxZoom: BASE_TILE_MAX_ZOOM
                    })
                });
            }).concat(new ol.layer.Vector({source: source, style: vectorStyle()})),
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
    // [[[[x,y]]]] MultiPolygon. Four bare numbers are a bbox [xmin, ymin, xmax, ymax].
    function geometryFromArray(coordinates) {
        if (!Array.isArray(coordinates)) throw new Error('Not an array');
        if (coordinates.length === 4 && coordinates.every(function (c) {
            return typeof c === 'number';
        })) {
            return ol.geom.Polygon.fromExtent(coordinates);
        }
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

    // Combined extent as [xmin, ymin, xmax, ymax], the ST_MakeEnvelope argument
    // order. Clones from transformedClones are already rounded, so this is too.
    function toExtentText(features) {
        const extent = ol.extent.createEmpty();
        features.forEach(function (feature) {
            ol.extent.extend(extent, feature.getGeometry().getExtent());
        });
        return JSON.stringify(extent).replaceAll(',', ', ');
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

    // The output (with its copy/download buttons) is rendered dynamically, so delegate.
    $(document).on('click', '.copy-btn', function () {
        const button = this;
        const code = button.closest('.group').querySelector('code');
        const text = code ? code.innerText : '';
        copyText(text).then(function () {
            button.innerText = 'Copied!';
            setTimeout(function () { button.innerText = 'Copy'; }, 1500);
        }).catch(function () {
            button.innerText = 'Copy failed';
            setTimeout(function () { button.innerText = 'Copy'; }, 1500);
        });
    });

    $(document).on('click', '.download-btn', function () {
        const code = this.closest('.group').querySelector('code');
        if (!code) return;
        downloadText(this.getAttribute('data-filename') || 'geometry.txt', code.innerText);
    });

    /* ----------------------------------------------------------------- *
     * Share links. The geometry travels in the URL hash, so it is never sent
     * to a server; it is deflate-compressed and base64url-encoded to keep
     * links short. Opening a link shows the geometry in the Viewer.
     * ----------------------------------------------------------------- */
    // Longer URLs break in some browsers and chat apps; Download covers those.
    const SHARE_MAX_LENGTH = 60000;

    // { text, type, projection } behind the Share button currently on screen.
    let currentShare = null;

    // A Share button for `share`, the Viewer input that reproduces the geometry:
    // its text plus the Input Type and Input Projection to read it with.
    function shareButtonHtml(share) {
        currentShare = share;
        return '<button class="share-btn shrink-0 text-sm text-white bg-slate-800 hover:bg-slate-700 px-3 py-1 rounded cursor-pointer">' +
            'Share link</button>';
    }

    // An output title with a Share button on its right.
    function shareableTitleHtml(title, share) {
        return '<div class="flex items-start justify-between gap-2">' +
            '<h3 class="text-xl text-[#1C274C] font-bold mb-1">' + escapeHtml(title) + '</h3>' +
            shareButtonHtml(share) + '</div>';
    }

    function deflateToBase64Url(text) {
        const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (buffer) {
            let binary = '';
            new Uint8Array(buffer).forEach(function (byte) {
                binary += String.fromCharCode(byte);
            });
            return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        });
    }

    function inflateFromBase64Url(encoded) {
        const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = Uint8Array.from(binary, function (ch) {
            return ch.charCodeAt(0);
        });
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).text();
    }

    function buildShareLink(share) {
        return deflateToBase64Url(share.text).then(function (data) {
            const params = new URLSearchParams({type: share.type, proj: share.projection, data: data});
            return location.href.split('#')[0] + '#' + params.toString();
        });
    }

    $(document).on('click', '.share-btn', function () {
        const button = this;
        hideError();
        buildShareLink(currentShare).then(function (link) {
            if (link.length > SHARE_MAX_LENGTH) {
                showError('This geometry is too large for a share link (' + Math.round(link.length / 1000) +
                    ' KB). Use Download instead.');
                return;
            }
            copyText(link).then(function () {
                button.innerText = 'Link copied!';
                setTimeout(function () {
                    button.innerText = 'Share link';
                }, 1500);
            }).catch(function () {
                window.prompt('Copy this link:', link);
            });
        }).catch(function (e) {
            console.error(e);
            showError('Could not create a share link in this browser.');
        });
    });

    function openShareLink() {
        const params = new URLSearchParams(location.hash.slice(1));
        if (!params.get('data')) return;
        inflateFromBase64Url(params.get('data')).then(function (text) {
            window.mapTools.viewer.showInput(text, params.get('type'), params.get('proj'));
        }).catch(function (e) {
            console.error(e);
            showError('This share link is broken or incomplete.');
        });
    }

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

        // Clear button and tab switches clear the source; forget the drawn feature
        // too, or changing an output selector would bring its output back.
        extractorSource.on('clear', function () {
            lastFeature = null;
            lastType = null;
        });

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

            let text, language, filename;
            if (exportType === 'wkt') {
                text = toWktText(clones);
                language = 'wkt';
                filename = 'geometry.wkt';
            } else if (exportType === 'geojson') {
                text = toGeoJsonText(clones);
                language = 'json';
                filename = 'geometry.geojson';
            } else {
                text = toArrayText(clones);
                language = 'json';
                filename = 'geometry.json';
            }

            // BBox also gets its bare extent alongside the polygon output.
            const extentHtml = lastType === 'BBox'
                ? '<h4 class="text-sm text-[#1C274C] font-bold mt-4">Extent [xmin, ymin, xmax, ymax]</h4>' +
                copyBlock(toExtentText(clones), 'json', 'bbox.json')
                : '';

            // The link shares exactly this output; the Viewer reads all three formats.
            showOutput(
                shareableTitleHtml('Drawn Geometry (' + lastType + ' in ' + targetProjection + ')',
                    {text: text, type: exportType, projection: targetProjection}) +
                statsRowHtml(lastFeature.getGeometry()) +
                copyBlock(text, language, filename) +
                extentHtml
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
        const wkbFormat = new ol.format.WKB();
        // extractStyles: false keeps our own style (and skips fetching KML icon images).
        const kmlFormat = new ol.format.KML({extractStyles: false});
        const gpxFormat = new ol.format.GPX();

        // An Error whose message is safe and useful to show the user as-is.
        function inputError(message) {
            const error = new Error(message);
            error.isInputError = true;
            return error;
        }

        function detectFormat(input) {
            if (input.startsWith('<')) return /<gpx[\s>]/i.test(input) ? 'gpx' : 'kml';
            // Encoded polylines use only ASCII 63–126: no digits, spaces, commas,
            // quotes or parentheses, so WKT/WKB/JSON never look like one.
            if (/^[\x3F-\x7E]+$/.test(input)) return 'polyline';
            // Hex WKB/EWKB, as printed by PostGIS; the first byte is the byte order.
            if (/^0[01](?:[0-9a-f]{2})+$/i.test(input)) return 'wkb';
            if (input.startsWith('{')) return 'geojson';
            if (input.startsWith('[')) return 'array';
            return 'wkt';
        }

        function withinLonLat(extent) {
            return extent[0] >= -180 && extent[2] <= 180 && extent[1] >= -90 && extent[3] <= 90;
        }

        // Coordinates that all fit within lon/lat bounds are almost certainly
        // EPSG:4326 — Web Mercator values within ±180 m / ±90 m of the origin
        // (middle of the Gulf of Guinea) don't occur in practice.
        function detectProjection(features) {
            const allLonLat = features.every(function (feature) {
                return withinLonLat(feature.getGeometry().getExtent());
            });
            return allLonLat ? PROJ.WGS84 : PROJ.MERCATOR;
        }

        // Maps a PostGIS SRID onto one of the supported projections. SRID 0 (or
        // none) means "unknown", which leaves the choice to auto-detection.
        function sridProjection(srid) {
            if (!srid) return null;
            const projection = ol.proj.get('EPSG:' + srid);
            if (projection && ol.proj.equivalent(projection, ol.proj.get(PROJ.WGS84))) return PROJ.WGS84;
            if (projection && ol.proj.equivalent(projection, ol.proj.get(PROJ.MERCATOR))) return PROJ.MERCATOR;
            throw inputError('Unsupported SRID ' + srid + '. Only 4326 and 3857 are supported.');
        }

        // EWKB sets the 0x20000000 flag on the geometry type and stores the SRID in
        // the next 4 bytes, in the byte order given by the first byte (01 = little).
        function ewkbSrid(hex) {
            const littleEndian = hex.slice(0, 2) === '01';
            const uint32 = function (offset) {
                const bytes = hex.slice(offset, offset + 8).match(/../g);
                return parseInt((littleEndian ? bytes.reverse() : bytes).join(''), 16);
            };
            return uint32(2) & 0x20000000 ? uint32(10) : null;
        }

        // Encoded polylines (Google, OSRM, …) usually use precision 5; Valhalla and
        // some others use 6. Precision-6 data decoded as 5 comes out 10× too large,
        // so fall back to 6 when precision 5 doesn't fit lon/lat bounds.
        function decodePolyline(input) {
            for (const factor of [1e5, 1e6]) {
                const geometry = new ol.format.Polyline({factor: factor}).readGeometry(input);
                if (geometry.getCoordinates().length && withinLonLat(geometry.getExtent())) return geometry;
            }
            throw inputError('Could not decode that encoded polyline.');
        }

        // Parses `input` as `format`. Returns the features plus the projection the
        // input itself declares (an SRID, or a lon/lat-only format), else null.
        function readInput(input, format) {
            if (format === 'geojson') {
                return {features: geojsonFormat.readFeatures(input), projection: null};
            }
            if (format === 'array') {
                return {features: [new ol.Feature(geometryFromArray(JSON.parse(input)))], projection: null};
            }
            if (format === 'kml') return {features: kmlFormat.readFeatures(input), projection: PROJ.WGS84};
            if (format === 'gpx') return {features: gpxFormat.readFeatures(input), projection: PROJ.WGS84};
            if (format === 'polyline') {
                return {features: [new ol.Feature(decodePolyline(input))], projection: PROJ.WGS84};
            }
            if (format === 'wkb') {
                return {features: [wkbFormat.readFeature(input)], projection: sridProjection(ewkbSrid(input))};
            }
            // WKT, optionally with a PostGIS EWKT "SRID=4326;" prefix.
            const srid = input.match(/^SRID=(\d+);\s*/i);
            return {
                features: [wktFormat.readFeature(srid ? input.slice(srid[0].length) : input)],
                projection: srid ? sridProjection(Number(srid[1])) : null
            };
        }

        // `share` is the input that was shown, so a share link reproduces it exactly.
        function renderViewerOutput(features, dataProjection, share) {
            const clones = transformedClones(features, dataProjection);
            const blocks = [];
            const arrayText = toArrayText(clones);
            if (arrayText) blocks.push({ label: 'Array', language: 'json', text: arrayText, filename: 'geometry.json' });
            blocks.push({ label: 'WKT', language: 'wkt', text: toWktText(clones), filename: 'geometry.wkt' });
            blocks.push({ label: 'GeoJSON', language: 'json', text: toGeoJsonText(clones), filename: 'geometry.geojson' });
            // A lone point has no meaningful extent.
            if (!(features.length === 1 && features[0].getGeometry().getType() === 'Point')) {
                blocks.push({
                    label: 'Extent [xmin, ymin, xmax, ymax]', language: 'json',
                    text: toExtentText(clones), filename: 'bbox.json'
                });
            }

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
                shareableTitleHtml('Geometry Info (' + features.length + ' feature' +
                    (features.length > 1 ? 's' : '') + ', ' + dataProjection + ')', share) +
                statsHtml +
                blocks.map(function (b) {
                    return '<h4 class="text-sm text-[#1C274C] font-bold mt-4">' + b.label + '</h4>' +
                        copyBlock(b.text, b.language, b.filename);
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
                const parsed = readInput(input, format);
                const features = parsed.features.filter(function (f) {
                    return f && f.getGeometry();
                });
                if (!features.length) throw new Error('No geometry found');

                // An explicit selection wins; otherwise trust what the input declares.
                const dataProjection = projSelection !== 'auto'
                    ? projSelection
                    : parsed.projection || detectProjection(features);
                features.forEach(function (f) {
                    f.getGeometry().transform(dataProjection, viewProjection);
                });

                viewerSource.clear();
                viewerSource.addFeatures(features);
                map.getView().fit(viewerSource.getExtent(), FIT_OPTIONS);
                // Share the resolved format and projection, not "auto", so the
                // link opens the same way even if detection rules change.
                renderViewerOutput(features, dataProjection, {text: input, type: format, projection: dataProjection});
            } catch (e) {
                console.error(e);
                showError(e.isInputError ? e.message : 'Please enter valid geometry!');
            }
        });

        // --- File import (button picker + drag-and-drop) ----------------
        // Reads a text file into the textarea and runs the viewer, reusing the
        // same auto-detection path as pasted input.
        const $geometryInput = $('#input-geometry');
        const importFileInput = document.getElementById('import-geometry-file');

        function importFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function () {
                $geometryInput.val(String(reader.result).trim());
                $('#show-viewer-map').trigger('click');
            };
            reader.onerror = function () { showError('Could not read that file.'); };
            reader.readAsText(file);
        }

        // True only when the drag carries files (so we don't hijack text drags).
        function dragHasFile(e) {
            const dt = e.originalEvent && e.originalEvent.dataTransfer;
            return !!dt && dt.types && Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
        }

        $('#import-geometry-btn').on('click', function () { importFileInput.click(); });
        $(importFileInput).on('change', function () {
            if (this.files && this.files[0]) importFile(this.files[0]);
            this.value = ''; // let the same file be re-imported later
        });

        $geometryInput.on('dragover dragenter', function (e) {
            if (!dragHasFile(e)) return;
            e.preventDefault();
            $geometryInput.addClass('border-slate-500 bg-slate-50');
        });
        $geometryInput.on('dragleave dragend', function () {
            $geometryInput.removeClass('border-slate-500 bg-slate-50');
        });
        $geometryInput.on('drop', function (e) {
            $geometryInput.removeClass('border-slate-500 bg-slate-50');
            if (!dragHasFile(e)) return;
            e.preventDefault();
            const dt = e.originalEvent.dataTransfer;
            if (dt.files && dt.files[0]) importFile(dt.files[0]);
        });

        // Switches to the Viewer and shows `text` as if the user had pasted it with
        // these selector values (used by share links). Unknown values fall back to auto.
        function showInput(text, type, projection) {
            document.querySelector('[data-dui-tab-target="geometry-tab"]').click();
            $geometryInput.val(text);
            [['#viewer-type-selector', type], ['#viewer-projection-selector', projection]].forEach(function (pair) {
                const $select = $(pair[0]).val(pair[1]);
                if ($select.val() === null) $select.val('auto');
            });
            // The tab was hidden until now; let OpenLayers measure it before fitting.
            map.updateSize();
            $('#show-viewer-map').trigger('click');
        }

        return {map: map, source: viewerSource, showInput: showInput};
    }

    /* ================================================================= *
     * Coordinate Converter
     * ================================================================= */
    function initConverter() {
        // Two numbers separated by a comma and/or spaces. Each may be an integer
        // or decimal, optionally signed.
        const COORD_RE = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/;
        // Selector value for lon/lat typed in "lat, lng" order, as Google Maps
        // and most phones copy it.
        const WGS84_LAT_LNG = 'EPSG:4326:lat-lng';

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

            let x = parseFloat(match[1]);
            let y = parseFloat(match[2]);

            if (sourceProjection === WGS84_LAT_LNG) {
                [x, y] = [y, x];
                sourceProjection = PROJ.WGS84;
            } else if (sourceProjection === 'auto') {
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

    openShareLink();
    // A share link pasted into an already-open tab changes only the hash.
    $(window).on('hashchange', openShareLink);
});
