<p align="center">
  <img src="images/screenshot.png" alt="Screenshot" />
</p>

# Map Tools

**Map-Tools** is an online map assistant that provides utilities such as geometry extraction, geometry viewer, and coordinate conversion. Whether you're a GIS professional, developer, or anyone working with spatial data, this tool makes these tasks easier and more efficient.

## Features

- **Geometry Extractor**: Draw Points, LineStrings, Polygons, and BBoxes, then export them as a coordinate Array, WKT,
  or GeoJSON in EPSG:3857 or EPSG:4326. Drag vertices to edit after drawing (Esc cancels a sketch, Backspace removes the
  last point), see live length/area measurements, and jump anywhere with the built-in location search. BBoxes also
  output their `[xmin, ymin, xmax, ymax]` extent. Copy or download any output as a file.
- **Geometry Viewer**: Paste — or import a file (file picker or drag-and-drop) — a coordinate Array, WKT, or GeoJSON,
  PostGIS EWKT (`SRID=4326;…`) or WKB/EWKB hex, KML, GPX, an encoded polyline (precision 5 or 6), or a
  `[xmin, ymin, xmax, ymax]` bbox. Format and projection are auto-detected (an SRID is honored). Visualize it on a map,
  inspect its measurements and extent, and convert it to Array, WKT, or GeoJSON with one-click copy or download.
- **Share Links**: Every drawn or viewed geometry has a *Share link* button that copies a link opening the same geometry
  in the Viewer. The geometry is compressed into the URL's `#` fragment, so it is never sent to a server.
- **Coordinate Converter**: Convert a coordinate between EPSG:3857 and EPSG:4326 — the source projection is
  auto-detected, "lat, lng" order as copied from Google Maps is supported, and Enter converts instantly.

## Live Demo

🔗 [Try it Online](https://abmohajeri.github.io/map-tools)

## Contributing

Contributions are welcome! Feel free to fork the repo, submit issues, or create pull requests.

## Support

If you like this project, give it a ⭐ on GitHub!
