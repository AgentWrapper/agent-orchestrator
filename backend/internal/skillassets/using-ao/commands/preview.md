# ao preview

Open a URL in the desktop browser panel for the current session. With no argument it opens the workspace's static entry point, falling back to this session's existing preview target when no entry point exists. A local file can be opened by its absolute `file://` URL. Use `ao preview clear` to empty the panel.

## Syntax

```
ao preview [url] [flags]
ao preview [command]
```

## Flags

No flags beyond `-h / --help`.

## Subcommands

---

### ao preview (bare form)

Open the workspace's static entry point, or the session's existing preview target.

**Examples:**

```bash
# Open the default entry point for this session's workspace
ao preview
```

```bash
# Open a local dev server
ao preview http://localhost:5173
(or wherever the dev server is running)
```

```bash
# Open a local HTML file
ao preview file://$(pwd)/index.html
```

---

### ao preview clear

Clear the desktop browser panel for the current session.

**Syntax:**
```
ao preview clear [flags]
```

**Flags:**

No flags beyond `-h / --help`.

**Examples:**

```bash
# Clear the preview panel
ao preview clear
```
