# Crow-Flix project guidance

## Project boundary

- This folder is the independent Crow-Flix source project.
- Treat the installed application under `%LOCALAPPDATA%\CrowFlix` and its app data as separate runtime state.
- Do not reinstall, replace, or modify the installed application unless the task explicitly asks for that.

## Stack and commands

- Stack: Tauri 2, Rust, React, TypeScript, and Vite.
- Install source dependencies with `npm ci`.
- Start the isolated desktop development app with `npm run tauri:dev`.
- Run source checks with `npm run check`.
- Run Rust tests with `npm run test:rust`; the catalogue test requires network access.
- Build a public Windows installer with `npm run release:build`, then verify it with `npm run release:verify`.

## Repository rules

- Keep `package-lock.json` and `src-tauri/Cargo.lock` committed.
- Do not commit generated dependencies, frontend output, Rust build caches, generated Tauri schemas, or logs.
- Treat `node_modules`, `dist`, `src-tauri/target`, and `src-tauri/gen/schemas` as reproducible generated output.
- Keep project documentation and design evidence portable by using paths relative to this repository.
- Before committing source changes, run the checks relevant to the files changed and report anything that could not be verified.
