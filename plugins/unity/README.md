# Unity

Makes Mango fit a Unity project. A folder is one when it has `Assets` and `ProjectSettings/ProjectVersion.txt`; a
folder holding several Unity projects works too (the projects right inside it).

## What it adds

- **A mark in the titlebar** after the project, with the editor version. It opens the Unity tool window.
- **The Files view**
  - `.meta` files are hidden. Show them with **View options > Unity .meta files**, the tool window, or **Unity: show or
    hide .meta files** in the command palette. **Open .meta file** in a file's menu opens one directly.
  - `Library`, `Temp`, `obj` and the generated `.csproj` and `.sln` files are hidden too, under their own switch.
  - A `.meta` without its asset always shows, marked in red.
  - Renaming or deleting an asset or folder takes its `.meta` along, so references keep working. Duplicating does
    not copy it: Unity gives the copy a GUID of its own.
  - A change to a hidden `.meta` shows on its asset.
  - Icons for scenes, prefabs, materials, scripts, shaders, graphs, animation, audio, models and the rest, and for
    Unity's special folders.
- **The editor** highlights scenes, prefabs, assets and `.meta` files as YAML, and shaders, UXML, USS and assembly
  definitions in their own languages.
- **The Unity tool window**: editor version, whether Unity has the project open, render pipeline, input handling,
  build scenes and packages.
- **Check meta files**: `.meta` files without an asset, assets without one, names that differ only in case, invalid
  `.meta` files (a merge conflict, two GUIDs, none) and GUIDs used twice.
- **Find references** and **Copy GUID** in a file's menu.
- **Agents** are told in one line how to treat a Unity project (below).

## Settings

| Setting | Default | |
|---|---|---|
| Unity file icons | on | Unity's file types get their own icons in Files and on tabs. |
| Tell agents about Unity | on | Runs in a Unity project get one line appended to the system prompt. |

The line names the editor version (no folder or product names) and says to keep `.meta` files with their assets, never
to change a GUID, to leave generated files alone and to edit scene and prefab YAML narrowly.

## Limits

- Moves made outside the Files view (a terminal, another program, an agent that ignores the note) do not take the
  `.meta` along. **Check meta files** finds what that breaks.
- The check and the reference search read the project's files, so they run only for projects on this computer.
  On a big project (10,000 assets) that takes seconds.
- Find references searches text assets, settings, `.meta` files and C# for the GUID. Binary files and files over 5 MB
  cannot be searched (the result counts them); other file types are not looked at, and loading by name or path
  (`Resources.Load`, Addressables addresses) is not found.
- A folder with more than 5,000 entries is listed in part: the check says so and judges no missing pairs there.
- Packages referenced with `file:` outside `Packages` are not treated as Unity folders.
- Build scenes are the global list; a Build Profile may override it.
- "Open in Unity" goes by the editor's own marker files, which a crash can leave behind.
- A folder opened inside a Unity project (say `Assets` itself) is not recognised: open the project's folder.
- In a remote environment, projects one folder down are found only among the first 24 subfolders or 2,000 entries.

It uses only the plugin API: no escape hatches, no network. The icons are drawn for this plugin and are not Unity's
artwork. Unity is a trademark of Unity Technologies, which has nothing to do with this plugin.
