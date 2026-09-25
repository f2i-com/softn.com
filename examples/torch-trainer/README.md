# Torch Trainer

A small machine-learning app: a one-neuron network (`torch.nn.Linear`) learns
y = 2x + 1 from five points, with loss, learned weight and bias, and a
prediction updating as you train. Its logic is Python using ZIPP's torch, and
it runs entirely in the browser with no network, account or permission.

- `logic/main.py` holds the model, the optimizer and the training step.
- `manifest.json` declares torch: `"config": { "python": { "packages": ["torch"] } }`.
  Without that declaration the runtime refuses the app's `import torch` by name.
- Each button trains a short batch of steps and returns, so the page stays
  responsive; the first click also pays for compiling torch (about a second).

Build the bundle with `node examples/torch-trainer/build.mjs`, then open
`examples/torch-trainer/TorchTrainer.softn` in the runtime (`/web/`, the + button,
or drop the file on the page). See `docs/engineering/ZIPP_LANGUAGES.md`,
"Machine learning with torch", for what torch covers here.
