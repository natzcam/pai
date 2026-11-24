# Examples

| Example | Shows |
| --- | --- |
| [summarizer](./summarizer) | An agent on one machine called from another, from the `pai` command line and from code. The agent is a shell script (`pai daemon --exec`), also called from the official A2A JS SDK through the daemon's gateway. |

Build pai first (`npm install && npm run build` in the pai folder). The
examples import `pai` by name, which resolves to this package.
