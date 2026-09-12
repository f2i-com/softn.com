# README screenshot provenance

These are direct browser screenshots of the real SoftN Builder and its live
preview, captured on 12 September 2026. They are not generated illustrations or
mockups. All app code comes from the checked-in
[Glamour Studio fixture](../../apps/softn-builder/src/utils/__fixtures__/GlamourStudio).

| Asset                 | Pixels      | View                                                                             |
| :-------------------- | :---------- | :------------------------------------------------------------------------------- |
| `builder-preview.jpg` | 2160 × 1500 | Builder in Preview mode, desktop app in its light theme.                         |
| `builder-data.jpg`    | 2160 × 1350 | Builder in Data mode, collection schemas and fictional seed records.             |
| `app-mobile.jpg`      | 558 × 1206  | The app iframe in Builder's Mobile preview, cropped to the iframe by Playwright. |

## Sample data and isolation

A temporary `.softn` ZIP was assembled from the fixture's unchanged `ui/` and
`logic/` directories. Its manifest used the title `Glamour Studio`, version
`1.0.0`, and the demo ID `softn-readme-glamour-demo`. An empty permission
declaration disabled optional capabilities. The archive also contained five
collections of synthetic XDB seed records:

- Four clients: Riley Chen, Casey Taylor, Jordan Lee and Morgan Brooks.
- Three staff members: Sam Rivers, Alex Quinn and Jamie Park.
- Four services: Cut & style, Colour refresh, Blow dry and Consultation.
- Four appointments using those fictional people and services.
- Three fictional activity entries.

The names, counts, dates and appointments are demonstration data. No real
account, customer, phone number, email, transcript, API key or booking was used.
No FormLogic or OAIY session was connected, and no AI request was made.

## Capture method

1. Build the shared packages and start Builder locally, for example with
   `npm run dev:builder`.
2. Open Builder in a fresh Playwright Chromium context with service workers
   blocked, a light browser theme, reduced motion, and device scale factor 1.5.
   Allow requests only to that local Builder origin.
3. Use Builder's **Open** file picker to load the temporary sample bundle.
4. Choose **Preview**, wait for the sample dashboard, then use the app's
   **Switch to light** button. Let the import toast disappear before capture.
5. Capture the desktop page at a 1440 × 1000 viewport. Use Builder's **Mobile**
   control and screenshot the actual iframe element for the mobile image.
6. Choose **Data** and capture the schema editor at a 1440 × 900 viewport.

JPEG quality is 90. The screenshots have not been retouched or composited.
The temporary bundle, browser profile, local storage and build output are not
part of these documentation assets. The screenshots show the current example's
layout and should be refreshed when that example or the builder changes.
