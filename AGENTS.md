# User Preferences

## Language

- Always write code, comments, commit messages, documentation, and any other implemented text in English, unless the user explicitly specifies another language.

## Technical documentation and library behavior

- Whenever the user asks about technical documentation or about the behavior of any library/framework, use the Context7 MCP (e.g. `context7` tools) to look it up, instead of answering from memory or general web search.

## Asking the user questions

- Whenever the agent needs to ask the user anything —including simple yes/no confirmations— it must use the `ask_user_question` tool (structured question panel) instead of asking in free text within the response.

## context-mode is active

Use ctx_* tools. The extension injects routing rules — follow them. Note for Pi users: if this project also has CLAUDE.md, Pi.dev reads both files and duplicates routing instructions in context — remove one.
