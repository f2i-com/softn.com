# Offline web apps

| App | Source | What to try |
| --- | --- | --- |
| Trail Pack | [Vanilla JavaScript](vanilla/) | Check off equipment for a day hike. |
| Ratio Bar | [React](react/) | Adjust the coffee dose to calculate how much water to pour. |
| Swatchbook | [Vue](vue/) | Choose a four-color palette and read its hex values. |

Each app keeps your last choice in local storage and carries its own styles. They all use the lite JavaScript engine.

From the repository root, with dependencies installed, run:

```sh
node examples/offline-web-apps/build.mjs
```

In Runtime Home, choose **Open folder** and select `dist/vanilla`, `dist/react` or `dist/vue` inside this example. Trail Pack also opens straight from its source folder. **Open file** accepts the three generated `.softn` archives in `dist/`.

To try it offline, open an app online, return to Runtime Home and wait for **Offline ready**. Disconnect, reload Runtime Home and reopen the app from its saved card.

The website serves these same archives from `apps/softn-site/public/examples/`. Run `node examples/offline-web-apps/build.mjs --publish` to refresh them after changing an example.

Open the archives in Studio or Builder to edit the original `app.js`, `main.jsx` or `App.vue`. The React and Vue archives include the same runnable modules that the editors export, so Runtime can start them offline.

The example sources use the repository’s [Apache 2.0 license](../../LICENSE). The archives include this license and the project notice. Each bundled framework carries its dependency licenses in the generated vendor module.
