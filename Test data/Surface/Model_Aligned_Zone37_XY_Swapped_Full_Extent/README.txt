Model coordinates: X = northing, Y = easting + 37000000, Z = elevation unchanged.

The full extent is preserved, with no clipping and no resampling. The source
file is not modified, and both zero values and NoData are retained.

Elevation is imported from `dem_xy37_full.asc`; the remote sensing imagery is
imported from `image_xy37_full.tif`, which must stay in the same folder as the
matching `.tfw` world file.

These coordinates follow the model axis order and cannot be assigned directly
to a standard east/north axis order EPSG projection.
