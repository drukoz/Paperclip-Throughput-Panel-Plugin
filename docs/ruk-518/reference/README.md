# RUK-518 reference files

Copies of the files the RUK-518 subtasks create or replace, as the CTO built and tested them in a prototype on 2026-11-04 (typecheck, `npm test` and `npm run build` all passed). Each subtask's spec says which file to copy where; `diff` must then print nothing.

Nothing here is compiled, tested or bundled: `tsconfig.json` includes only `src` and `scripts`, and `npm test` finds no test file here. The CTO deletes this folder before delivery.
