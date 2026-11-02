# shape_compare

You get the contract file for each language, each under its path and its language. Read nothing else.

## Answer

One row per difference, and nothing before or after. Each row is this line, word for word:

- drift: <method or type> | <lang>: <shape> | <lang>: <shape> | kind: <sync-async|missing|extra|error-model|naming|types> | files: <path:line>, <path:line>

When the files hold no difference, answer the single word `none`.

## Rules

- `sync-async` is one language blocking where the other returns a future, promise or callback.
- `missing` is a method or type the first file has and the second does not.
- `extra` is a method or type the second file has and the first does not.
- `error-model` is one language throwing where the other returns the error, or the two raising different errors.
- `naming` is the same method or type under a name that is not the language's spelling of the other's.
- `types` is a parameter, field or return type that differs.
- `files` cites one line in each of the two files the row compares. The machine refuses a row without both citations.
