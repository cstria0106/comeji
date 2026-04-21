# Project Notes

- Use `pnpm` for all JavaScript and TypeScript commands.
- Keep TypeScript strict and avoid `as any` style escapes.
- Keep modules small: main-process app wiring, sprite storage, chat responder, and renderer views should stay separated.
- Do not edit generated output in `dist/`, dependency folders, or runtime data in `.shimeji/`.
- Run `pnpm run typecheck` before handing off meaningful code changes.
