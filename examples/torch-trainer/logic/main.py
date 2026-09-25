# Torch Trainer: fit y = 2x + 1 with a one-neuron network.
#
# torch is declared in manifest.json ("config": {"python": {"packages":
# ["torch"]}}); without that the runtime refuses the import by name.
# Tensors, the model and the optimizer stay in Python. What the markup shows
# is kept in plain numbers and lists, which are mirrored as state.
import torch
import torch.nn as nn

torch.manual_seed(0)
xs = torch.tensor([[0.0], [1.0], [2.0], [3.0], [4.0]])
ys = xs * 2.0 + 1.0

model = nn.Linear(1, 1)
optimizer = torch.optim.SGD(model.parameters(), lr=0.03)

loss = 0.0
steps = 0
weight = 0.0
bias = 0.0
prediction = 0.0
history = []


def read_parameters():
    global weight, bias, prediction
    weight = round(float(model.weight[0][0]), 4)
    bias = round(float(model.bias[0]), 4)
    with torch.no_grad():
        prediction = round(float(model(torch.tensor([[10.0]]))[0][0]), 3)


def train(count):
    # Short calls keep the page responsive: each click trains a batch of
    # steps and returns, rather than one long loop on the page's thread.
    global loss, steps, history
    for _ in range(count):
        optimizer.zero_grad()
        current = ((model(xs) - ys) ** 2).mean()
        current.backward()
        optimizer.step()
        loss = round(float(current), 6)
        steps = steps + 1
    history = (history + [loss])[-12:]
    read_parameters()


def reset():
    global model, optimizer, loss, steps, history
    torch.manual_seed(0)
    model = nn.Linear(1, 1)
    optimizer = torch.optim.SGD(model.parameters(), lr=0.03)
    loss = 0.0
    steps = 0
    history = []
    read_parameters()


read_parameters()
