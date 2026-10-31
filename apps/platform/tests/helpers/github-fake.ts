/**
 * An in-memory GitHub at the `githubRequest` boundary.
 *
 * Enough of the REST surface for scaffolding and conversion: generating a
 * repository from a template, file contents per branch, Actions variables,
 * branch refs and pull requests. Mocking here rather than higher up means the
 * real request code in `lib/github/rest.ts` — paths, base64, the 409/422
 * fallbacks — runs in the tests.
 */

export interface FakeCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

type ErrorClass = new (message: string, status: number) => Error;

interface Pull {
  repo: string;
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  html_url: string;
}

export function encodeBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function createGithubFake(ApiError: ErrorClass) {
  let commit = 0;
  const nextSha = () => `sha${(commit += 1)}`;

  const state = {
    /** `owner/name@branch` → path → file. */
    branches: new Map<string, Map<string, { sha: string; text: string }>>(),
    /** `owner/name@branch` → head commit. */
    heads: new Map<string, string>(),
    variables: new Map<string, string>(),
    pulls: [] as Pull[],
    calls: [] as FakeCall[],
    /** Return an error to make the matching request fail. */
    failWhen: null as null | ((call: FakeCall) => { status: number; message: string } | null),
  };

  function branch(repo: string, name: string) {
    const key = `${repo}@${name}`;
    if (!state.branches.has(key)) {
      state.branches.set(key, new Map());
      state.heads.set(key, nextSha());
    }
    return state.branches.get(key)!;
  }

  function seedFile(repo: string, branchName: string, path: string, text: string) {
    branch(repo, branchName).set(path, { sha: nextSha(), text });
    state.heads.set(`${repo}@${branchName}`, nextSha());
  }

  function file(repo: string, branchName: string, path: string): string | null {
    return state.branches.get(`${repo}@${branchName}`)?.get(path)?.text ?? null;
  }

  function reset() {
    commit = 0;
    state.branches.clear();
    state.heads.clear();
    state.variables.clear();
    state.pulls.length = 0;
    state.calls.length = 0;
    state.failWhen = null;
  }

  function writes() {
    return state.calls.filter((c) => c.method !== "GET");
  }

  async function request(
    _installationId: string,
    path: string,
    options: { method?: string; body?: Record<string, unknown>; allowStatuses?: number[] } = {},
  ): Promise<{ status: number; data: unknown }> {
    const method = options.method ?? "GET";
    const call = { method, path, body: options.body };
    state.calls.push(call);

    const respond = (status: number, data: unknown) => {
      if (status >= 400 && !(options.allowStatuses ?? []).includes(status)) {
        throw new ApiError(`GitHub request failed (HTTP ${status}).`, status);
      }
      return { status, data };
    };

    const failure = state.failWhen?.(call);
    if (failure) throw new ApiError(`GitHub request failed (HTTP ${failure.status}). ${failure.message}`, failure.status);

    const url = new URL(`https://api.github.test${path}`);
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return respond(404, {});
    const repo = `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
    const rest = match[3] ?? "";
    const body = options.body ?? {};

    if (rest === "/generate" && method === "POST") {
      const created = `${body.owner}/${body.name}`;
      branch(created, "main");
      return respond(201, {
        id: 1,
        node_id: `R_${String(body.name)}`,
        name: body.name,
        full_name: created,
        private: body.private,
        default_branch: "main",
        html_url: `https://github.com/${created}`,
      });
    }

    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (contents) {
      const filePath = decodeURIComponent(contents[1]!);
      if (method === "GET") {
        const ref = url.searchParams.get("ref") ?? "main";
        const found = state.branches.get(`${repo}@${ref}`)?.get(filePath);
        return found
          ? respond(200, { sha: found.sha, content: encodeBase64(found.text).replace(/(.{60})/g, "$1\n") })
          : respond(404, {});
      }
      if (method === "PUT") {
        const target = branch(repo, String(body.branch));
        const existing = target.get(filePath);
        if (existing && existing.sha !== body.sha) return respond(409, {});
        if (!existing && body.sha) return respond(422, {});
        target.set(filePath, { sha: nextSha(), text: decodeBase64(String(body.content)) });
        state.heads.set(`${repo}@${body.branch}`, nextSha());
        return respond(existing ? 200 : 201, {});
      }
    }

    if (rest === "/actions/variables" && method === "POST") {
      const key = `${repo}:${body.name}`;
      if (state.variables.has(key)) return respond(409, {});
      state.variables.set(key, String(body.value));
      return respond(201, {});
    }
    const variable = /^\/actions\/variables\/(.+)$/.exec(rest);
    if (variable && method === "PATCH") {
      state.variables.set(`${repo}:${decodeURIComponent(variable[1]!)}`, String(body.value));
      return respond(204, undefined);
    }

    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (ref && method === "GET") {
      const head = state.heads.get(`${repo}@${decodeURIComponent(ref[1]!)}`);
      return head ? respond(200, { object: { sha: head } }) : respond(404, {});
    }
    if (rest === "/git/refs" && method === "POST") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (state.heads.has(`${repo}@${name}`)) return respond(422, {});
      copyBranchAt(repo, name, String(body.sha));
      return respond(201, {});
    }
    const moved = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (moved && method === "PATCH") {
      copyBranchAt(repo, decodeURIComponent(moved[1]!), String(body.sha));
      return respond(200, {});
    }

    if (rest === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head")?.split(":")[1];
      return respond(
        200,
        state.pulls.filter((p) => p.repo === repo && p.head === head),
      );
    }
    if (rest === "/pulls" && method === "POST") {
      const number = state.pulls.length + 1;
      const pull: Pull = {
        repo,
        number,
        head: String(body.head),
        base: String(body.base),
        title: String(body.title),
        body: String(body.body),
        html_url: `https://github.com/${repo}/pull/${number}`,
      };
      state.pulls.push(pull);
      return respond(201, pull);
    }

    return respond(404, {});
  }

  /** A branch pointed at `sha` gets the files of whichever branch has it as head. */
  function copyBranchAt(repo: string, name: string, sha: string) {
    const source = [...state.heads.entries()].find(([key, head]) => head === sha && key.startsWith(`${repo}@`));
    const files = source ? new Map(state.branches.get(source[0])) : new Map();
    state.branches.set(`${repo}@${name}`, files);
    state.heads.set(`${repo}@${name}`, sha);
  }

  return { state, request, seedFile, file, reset, writes };
}
