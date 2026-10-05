## Working with the user

- **Don't build until the user says go.** While a change is being discussed (questions, options, "what do you think?"), only answer: explain, recommend, ask. Don't edit files, start agents, deploy or send transactions. Start building only after an explicit go-ahead ("go ahead", "build it", "do it", "yes, implement"). Agreeing with a proposal ("I agree", "makes sense") is not a go-ahead; ask "Shall I build it?" and wait.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
