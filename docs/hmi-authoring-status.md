# Siemens HMI implementation status

Version 0.20.1. Scope: Classic WinCC AND Unified this round; other vendors deferred.
Real TIA project writes and simulation have not been accepted yet. Offline tests
and public-API compilation do not satisfy native acceptance.

| Function | Classic WinCC V20 | Unified V20 |
| --- | --- | --- |
| New isolated project/device | Implemented; native acceptance pending | Implemented; native acceptance pending |
| Screen generation | Native XML candidates | Public native object creation program |
| Reusable layout | Native ScreenTemplate candidate | Expanded shared layout; native faceplates not implemented |
| Text, rectangle, button, IO field | Implemented candidates | Implemented API mapping |
| Navigation / press-release | Native function-list candidates | Native event scripts and unload reset |
| Internal tags | Generated tag-table XML candidates | Typed public API creation |
| PLC connections / external tags | Supplied native resource import | Explicit public-API driver/parameter/address mapping implemented; native validation pending |
| Discrete alarms and alarm view | Native authoring not implemented | Alarm classes, exact bit triggers, localized texts and native view implemented; native validation pending |
| Native resource bundle | Screen/template/tag/script/lists/graphics/connections; partial dependency coverage | Complete native bundle not implemented |
| Existing object inspection | Native XML export | Scoped public-property observation, including grouped screens |
| Existing geometry/color/text edits | Offline exact XML edits; approved replacement import | Approved native property setters |
| Existing dependency-changing edits | Not enabled | Not enabled |
| Exact plan / token / stale check | Implemented | Implemented |
| Compile / independent readback | Implemented orchestration; real test pending | Implemented orchestration; real test pending |
| Startup screen configuration | Public mapping unresolved; generated project requires manual startup selection | Public StartScreen plus readback implemented |
| Offline interactive preview | Implemented, not TIA simulation | Implemented, not TIA simulation |
| Realtime trend view | Native authoring not implemented | Exact numeric tags, time window, range, labels/colors and readback implemented; native validation pending |
| Recipes, history logging, user permissions, native reusable components | Complete authoring not implemented | Complete authoring not implemented |
| Complete device compatibility profiles | Not implemented | Enum validation only; catalog compatibility pending |
| Runtime simulation and rendered native acceptance | Deferred | Deferred |

The complete Siemens requirement is **not finished** while development gaps in
this matrix remain. Do not label them all as merely waiting for real testing.

Next development work is native resource/dependency coverage, advanced
controls/resources, and the Classic startup
configuration route. Then run the already specified isolated native acceptance
workflow before treating any row as natively verified.

References: [requirements](hmi-authoring-requirements.md),
[Classic workflow](hmi-authoring.md), [Unified workflow](hmi-unified.md).
