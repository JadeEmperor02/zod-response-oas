# Expected outcomes (checklist)

Run extract → generate and mark each row.

| #   | Handler                | Confident typeTexts?               | Warnings expected?   | ts-to-zod  | Notes                     |
| --- | ---------------------- | ---------------------------------- | -------------------- | ---------- | ------------------------- |
| 01  | simple                 | yes `{ id: string; name: string }` | no                   | ok         | baseline                  |
| 02  | nested                 | yes deep object                    | no                   | ok         |                           |
| 03  | list                   | yes array of objects               | no                   | ok         |                           |
| 04  | mapped                 | yes projected array                | no                   | ok         | if map callback inferred  |
| 05  | typed                  | yes UserResponse fields            | no                   | ok         | interface                 |
| 06  | optionalProps          | yes optional name                  | no                   | ok         |                           |
| 07  | unions                 | yes union                          | no                   | ok         |                           |
| 08  | ternary                | yes union of arms                  | no                   | ok         |                           |
| 09  | multipleCalls          | **two** distinct texts             | no                   | ok → union | critical: do not collapse |
| 10  | noData                 | `"undefined"` → `{}`               | no                   | ok         |                           |
| 11  | failComputedVariable   | weak / unknown                     | maybe                | may fail   | opaque                    |
| 12  | failSpread             | none                               | **yes** spread       | n/a        | extractor continue        |
| 13  | failBuildResponse      | none                               | **yes** non-literal  | n/a        |                           |
| 14  | failGeneric            | type with generic                  | no extract issue     | **fail**   | surface handler           |
| 15  | constArrow             | yes                                | no                   | ok         | VariableDeclaration name  |
| 16  | messageAndOthers       | yes `{ count: number }`            | no                   | ok         | envelope ignored          |
| 17  | primitive\*            | yes primitives/null                | no                   | ok         | four handlers             |
| 18  | asConstLiteral         | yes literals                       | no                   | ok         |                           |
| 19  | arrayOfUnions          | yes                                | no                   | ok         |                           |
| 20  | recordIndex            | Record/index                       | no                   | maybe      |                           |
| 21  | readonlyTuple          | tuple                              | no                   | maybe      |                           |
| 22  | intersection           | intersection                       | no                   | ok         |                           |
| 23  | nestedOptionalNullable | yes                                | no                   | ok         |                           |
| 24  | failComputedKey        | partial / index                    | maybe                | maybe      |                           |
| 25  | mongooseRawDoc         | type text + **warn**               | yes HydratedDocument | ok         |                           |
| 25  | mongooseNormalized     | clean object                       | no                   | ok         |                           |
| 26  | deeplyNested           | yes                                | no                   | ok         |                           |
| 27  | emptyObject            | `{}`                               | no                   | ok         |                           |
| 28  | promiseUnwrapped       | yes resolved type                  | no                   | ok         | await                     |

Pass criteria for the **extractor** alone:

- Every `fail-*` that hits an object-literal guard produces a warning string mentioning the line.
- `multipleCalls` has `typeTexts.length === 2`.
- `constArrow` appears with handler name `"constArrow"`.
- Handlers with only warnings still appear in the results array (not dropped).

Pass criteria for **generateZodSchemas**:

- Multi-shape handlers emit `z.union([...])` and a single map entry.
- ts-to-zod failure names the offending shape/handler rather than emitting `z.any()`.
