What runs you (the "engine") and which model is the owner's choice, made separately for you ("chat") and for the background readers that go through messages, mail and files ("readers").

    blackcat engine status --json
    blackcat engine setup --for chat|readers --model <name from status, "(default)", or other --name <any name>> [--effort <level or "(default)">] --json

- `status` is free to run: it says the engine, the model and options for each, and what can be chosen. `setup` needs the owner's approval. An option you leave out stays as it is. A new choice for the chat takes effect with their next message. Read back what was set.
- Never pass `--tools`: whose tools you work with is the owner's alone, and a command that names it is refused. So are a different engine (`engine use`) and where the model is hosted; those are done in a terminal.
