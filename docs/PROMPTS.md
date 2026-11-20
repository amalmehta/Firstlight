# Prompt log

## 2026-11-19: build v1 from the spec

1. "full 3d graphics library that can make extremely novel high fiedelity graphics by looking at the SOTA reseach: build this project. Read full 3d graphics library that can make extremely novel high fiedelity graphics by looking at the SOTA reseach.md in this folder and build what it describes, following its META-INSTRUCTIONS exactly."
   → Read the spec. Found three earlier graphics projects (GraphicsLibrary, beautiful_viz, 3d_viz) and pushed back on building a fourth.
   Settled in the question widget: a TypeScript library on three.js; ES module import; win condition "a cinematic scene in ~30 lines".

2. Answers to the second round: all four first uses (robotics viewer, worlds, science, portfolio hero); v1 module sky and atmosphere; public repo plus Pages demo; calm daylight.
   → Scope narrowed to the core plus the Hillaire sky.

3. "look at cs184 from berkeley for concepts"
   → Read the CS184 Fall 2026 syllabus. Modules are now mapped to its lectures (docs/CONCEPTS.md).
   Third round: write Hillaire 2020 ourselves, CS184 as a concept map with citations, an alpine valley demo, the name Firstlight.

4. Done criteria accepted as written.
   → Built v1: atmosphere (CPU reference + GPU LUTs), stage, terrain, demo, hello, self-check, docs.

5. "Push, MIT license"
   → Added an MIT LICENSE and a GitHub Actions workflow (typecheck, test, build, deploy to Pages). Created the public repo amalmehta/Firstlight and pushed main.
