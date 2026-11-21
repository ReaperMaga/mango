# Prompt templates

Turns prompts you type again and again into slash commands. Each line of the **Templates** setting
(Settings > Plugins > Prompt templates) is one command:

```
explain: Explain {{args|the code we just looked at}} step by step.
```

Typing `/explain the retry loop` in the composer sends "Explain the retry loop step by step." to the agent.

- `{{args}}` is what you type after the command, `{{args|fallback}}` the same with a fallback for when you type nothing.
- `{{project}}` is the project folder's name.
- A template without `{{args}}` still gets what you typed, as its own paragraph.
- `\n` starts a new line; lines starting with `#` are ignored.

It ships with `/explain`, `/tests`, `/review-diff` and `/docs`. Edit the list and the commands change at once.
A line Mango cannot read is skipped and named in the plugin's log.

Shows: `chat.slashCommands`, `settings.onChange`.
