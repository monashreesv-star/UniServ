# Third-Party Software Notices and Licenses

This project incorporates open-source libraries, web map services, and media assets. This document details their licensing and attribution.

---

## 1. AG Grid Community

* **Package:** `ag-grid-community`
* **Version:** `36.3.0`
* **License:** MIT License
* **Copyright:** (c) 2015-2026 AG GRID LTD
* **Files Vendored:**
  * `server/public/vendor/ag-grid/ag-grid-community.min.js`
  * `server/public/vendor/ag-grid/ag-grid.min.css`
  * `server/public/vendor/ag-grid/ag-theme-quartz.min.css`
  * `server/public/vendor/ag-grid/LICENSE.txt`

### License Text:
```
The MIT License (MIT)
Copyright (c) 2015-2026 AG GRID LTD

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Core Frontend & Framework Dependencies

| Package | Version | License | Copyright / Publisher |
|---|---|---|---|
| `react` | `19.2.3` | MIT | Meta Platforms, Inc. |
| `react-dom` | `19.2.3` | MIT | Meta Platforms, Inc. |
| `react-native` | `0.86.3` | MIT | Meta Platforms, Inc. |
| `react-native-web` | `0.21.2` | MIT | Nicolas Gallagher |
| `expo` | `~57.0.18` | MIT | 650 Industries, Inc. (Expo) |
| `@expo/vector-icons` | `^15.0.2` | MIT | Expo Team |
| `@react-navigation/*` | `^7.x` | MIT | React Navigation Contributors |
| `@react-native-async-storage/async-storage` | `2.2.0` | MIT | React Native Community |
| `react-native-safe-area-context` | `~5.7.0` | MIT | Janic Duplessis |
| `react-native-screens` | `~4.26.0` | MIT | Software Mansion S.A. |
| `react-native-svg` | `15.15.4` | MIT | Horcrux & React Native Community |

---

## 3. Core Server Dependencies

| Package | Version | License | Copyright / Publisher |
|---|---|---|---|
| `express` | `^4.21.2` | MIT | StrongLoop, Inc. & Express Contributors |
| `cors` | `^2.8.5` | MIT | Troy Goode |
| `dotenv` | `^16.4.7` | BSD-2-Clause | Scott Motte |

---

## 4. Map Tiles, Routing & Geospatial Services

The application embed (`src/components/RealLiveTrackingMap.js`) uses Leaflet and public web map endpoints. Attribution is rendered in the map UI control:

1. **Leaflet (`1.9.4`)**:
   * **License:** BSD-2-Clause
   * **Copyright:** (c) 2010-2023, Vladimir Agafonkin; (c) 2010-2011, CloudMade.
   * **UI Display:** Embedded map rendering engine.

2. **CartoDB Voyager Road Tiles**:
   * **Endpoint:** `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png`
   * **Attribution:** Rendered as `© OpenStreetMap & CartoDB` in the map control.
   * **License / Terms:** Creative Commons Attribution (CC BY 4.0) with OpenStreetMap data under Open Database License (ODbL 1.0).

3. **Esri World Imagery (Satellite Layer Toggle)**:
   * **Endpoint:** `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
   * **Attribution:** Rendered as `© Esri & NASA` in the map control.
   * **Terms:** Permitted for non-commercial web map display with attribution.

4. **Project OSRM Public Routing API**:
   * **Endpoint:** `https://router.project-osrm.org/route/v1/driving/...`
   * **License:** BSD-2-Clause (OSRM project). Free public demo service used for demo route geometries.

---

## 5. Media & Photography Assets

* **Unsplash Stock Photos (used in mock cooperative profiles and sample extra-work attachments)**:
  * **License:** Unsplash License (https://unsplash.com/license).
  * **Terms:** Free commercial and non-commercial use, no permission required.
* **Ionicons (`@expo/vector-icons/Ionicons`)**:
  * **License:** MIT License.
  * **Copyright:** (c) 2015-present Ionic (https://ionic.io/).
