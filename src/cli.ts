// Todo CLI over Stardust.
//
//   node src/cli.ts ls
//   node src/cli.ts add "Buy milk" --priority high
//   node src/cli.ts done 42
//   node src/cli.ts undone 42
//   node src/cli.ts rm 42
//   node src/cli.ts watch          # live stream, driven by the Stardust reactor
//
// Env: STARDUST_URL (default http://localhost:1981)

import {
  type Priority,
  type Todo,
  addTodo,
  listTodos,
  migrateOrphanTodos,
  removeTodo,
  setDone,
  toggleTodo,
  watchTodos,
} from "./todos.ts";
import { defaultWorkspace } from "./workspace.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const prioTag: Record<Priority, string> = {
  high: c.red("●high"),
  med: c.yellow("●med "),
  low: c.dim("●low "),
};

function render(todos: Todo[]): string {
  if (!todos.length) return c.dim("  (no todos yet — add one with: cli add \"...\")");
  return todos
    .map((t) => {
      const box = t.done ? c.green("[x]") : "[ ]";
      const title = t.done ? c.dim(t.title) : t.title;
      return `  ${box} ${prioTag[t.priority]} ${c.dim(`#${t.id}`)} ${title}`;
    })
    .join("\n");
}

function parsePriority(args: string[]): Priority {
  const i = args.findIndex((a) => a === "--priority" || a === "-p");
  const v = i >= 0 ? args[i + 1] : undefined;
  return v === "low" || v === "med" || v === "high" ? v : "med";
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const ctx = await defaultWorkspace(); // single default tenant for the CLI

  switch (cmd) {
    case "add": {
      const words: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--priority" || rest[i] === "-p") i++; // skip flag + its value
        else words.push(rest[i]);
      }
      const title = words.join(" ").trim();
      if (!title) throw new Error('usage: add "title" [--priority low|med|high]');
      const id = await addTodo(ctx, title, parsePriority(rest));
      console.log(c.green(`added #${id}`), title);
      console.log(render(await listTodos(ctx)));
      break;
    }
    case "done":
    case "undone": {
      const id = Number(rest[0]);
      if (!id) throw new Error(`usage: ${cmd} <id>`);
      await setDone(ctx, id, cmd === "done");
      console.log(render(await listTodos(ctx)));
      break;
    }
    case "toggle": {
      const id = Number(rest[0]);
      if (!id) throw new Error("usage: toggle <id>");
      const now = await toggleTodo(ctx, id);
      console.log(c.cyan(`#${id} -> ${now ? "done" : "open"}`));
      console.log(render(await listTodos(ctx)));
      break;
    }
    case "rm": {
      const id = Number(rest[0]);
      if (!id) throw new Error("usage: rm <id>");
      await removeTodo(ctx, id);
      console.log(c.red(`removed #${id}`));
      console.log(render(await listTodos(ctx)));
      break;
    }
    case "watch": {
      console.log(c.bold("watching todos live — Ctrl-C to stop\n"));
      const ac = new AbortController();
      process.on("SIGINT", () => {
        ac.abort();
        process.exit(0);
      });
      await watchTodos(ctx, (todos) => {
        // redraw
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(c.bold("TODOS") + c.dim("  (live via Stardust reactor)\n"));
        console.log(render(todos));
        console.log(c.dim(`\n  ${todos.filter((t) => !t.done).length} open / ${todos.length} total`));
      }, ac.signal);
      break;
    }
    case "migrate": {
      // OPTIONAL. The default workspace already adopts legacy todos at read
      // time (or/not), so this is never required — it just stamps a permanent
      // workspace ref onto orphan todos if you prefer that.
      const n = await migrateOrphanTodos(ctx);
      console.log(n ? c.green(`stamped ${n} legacy todo(s) into the default workspace`) : c.dim("no orphan todos"));
      break;
    }
    case "ls":
    case undefined: {
      console.log(c.bold("TODOS\n"));
      console.log(render(await listTodos(ctx)));
      break;
    }
    default:
      console.log(`unknown command: ${cmd}\n\ncommands: ls | add | done | undone | toggle | rm | watch | migrate`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(c.red((e as Error).message));
  process.exit(1);
});
