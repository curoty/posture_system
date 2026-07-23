# Project Python Environment

For every Python-related command in this repository, use this interpreter:

`D:\py_project\new_competition\.venv\Scripts\python.exe`

This includes:

- running Python scripts;
- running tests and linters;
- compiling/checking Python files;
- inspecting installed packages;
- installing project Python dependencies.

Do not silently substitute another Python interpreter, including system Python,
`py`, a bundled Codex runtime, Conda, or a newly created virtual environment.

On PowerShell, invoke it with the call operator:

```powershell
& 'D:\py_project\new_competition\.venv\Scripts\python.exe' <arguments>
```

If the execution sandbox prevents this interpreter from starting, request the
required execution permission when appropriate or report the restriction
clearly. Do not describe the virtual environment as broken solely because a
sandboxed process cannot launch its base interpreter.
