Simulated tunnels around the 1-1 orebody

This is simulated data used to demonstrate project display, import and spatial
relationships. It is not a surveyed tunnel and not a construction design.

Source: 3D geological model `ljx_2 - 1-1.ts`. The original X, Y and Z
coordinates and the zone-37 band number are preserved; no axes were swapped
and the original orebody was not moved.

Layout: five surrounding levels at -250, -100, 50, 200 and 350 metres. For
each level the convex hull of the orebody triangle slice is taken, then offset
outwards by 40 metres to form the tunnel centreline. Ordinary drifts have a
4-metre section diameter (approximated by an octagon); the peripheral
connection shafts are 6 metres in diameter. Connection drifts link each
surrounding level to the peripheral shafts. The centreline coordinates are in
the accompanying JSON.

The surrounding sections are computed from the slice at their own elevation.
Full-elevation clearance is not guaranteed, and the ground surface, other rock
bodies and engineering constraints have not been checked. Each drift is closed
independently and the junctions overlap; no boolean union was performed at the
intersections.

How to import:
1. In the project's 3D tunnel data category, import
   `simulated_1_1_surrounding_tunnels.dtm`. The matching `.str` file must stay
   in the same folder.
2. If you prefer the general 3D model import, `simulated_1_1_surrounding_tunnels.ts`
   is available as an alternative.
3. The two formats are the same model. Import only one of them to avoid
   overlapping geometry.
4. Display the original orebody at the same time and use the existing
   transparency or visibility settings to look inside the tunnels.

Verification: 11,088 vertices and 22,152 triangles; the indices are valid,
every mesh edge is shared by two triangles, and each drift mesh is closed.
`Generate_Simulated_Tunnels.py` reproduces the files; the original orebody and
the pre-existing tunnel files are not modified.
