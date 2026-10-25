import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import {
  fakeDiscovery,
  fakeSourceControlProvider,
} from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient } from "effect/http";
import { VcsProcessSpawnError } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsPullRequestCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestCli";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as BitbucketPullRequestApi from "@t3tools/source-control-bitbucket/server/BitbucketPullRequestApi";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as GitCafeApi from "@t3tools/source-control-gitcafe/server/GitCafeApi";
import * as GitCafeCredentials from "@t3tools/source-control-gitcafe/server/GitCafeCredentials";
import * as ForgejoPullRequestProvider from "@t3tools/source-control-forgejo/server/ForgejoPullRequestProvider";
import * as ForgejoSourceControlProvider from "@t3tools/source-control-forgejo/server/ForgejoSourceControlProvider";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

const layerSourceControlProviderRegistryTest = (input: {
  readonly bitbucket: Partial<BitbucketApi.BitbucketApi["Service"]>;
  readonly process: Partial<VcsProcess.VcsProcess["Service"]>;
}) =>
  SourceControlProviderRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)(input.bitbucket),
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({}),
        ServerSettings.ServerSettingsService.layerTest(),
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({}),
        Layer.mock(GitHubRest.GitHubRest)({}),
        // The GitHub provider's GraphQL reads go through these; no test here makes one.
        Layer.mock(GitHubRequestPolicy.GitHubRequestPolicy)({}),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die(new Error("Unexpected GitHub GraphQL read"))),
        ),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(GitLabCli.GitLabCli)({}),
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({}),
        Layer.mock(ForgejoCli.ForgejoCli)({ listLogins: () => Effect.succeed([]) }),
        Layer.mock(GitCafeApi.GitCafeApi)({}),
        Layer.mock(GitCafeCredentials.GitCafeCredentials)({
          cliEnv: () => Effect.succeed({}),
        }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
        Layer.mock(VcsProcess.VcsProcess)(input.process),
        ServerSourceControlHost.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(VcsProcess.VcsProcess)(input.process),
              ServerSettings.ServerSettingsService.layerTest(),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
              Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
            ),
          ),
        ),
      ),
    ),
  );

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("reads Forgejo details and keeps review summaries out of GETs", () => {
  const methods: string[] = [];
  const fetchReview = async (
    ...[input, init]: Parameters<Context.Service.Shape<typeof FetchHttpClient.Fetch>>
  ) => {
    const request = new Request(input instanceof Request ? input.url : String(input), {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
      ...(init?.body === undefined ? {} : { body: init.body }),
    });
    methods.push(request.method);
    if (request.method === "GET") {
      if (request.url === "https://forgejo.test/api/v1/user") {
        return new Response(encodeJson({ login: "maria" }));
      }
      if (request.url === "https://forgejo.test/api/v1/repos/maria/project") {
        return new Response(encodeJson({ full_name: "maria/project" }));
      }
      if (request.url === "https://forgejo.test/api/v1/repos/maria/project/branches/main") {
        return new Response(encodeJson({ enable_status_check: false }));
      }
      if (request.url.startsWith("https://forgejo.test/api/v1/repos/maria/project/statuses/")) {
        return new Response("[]");
      }
      assert.strictEqual(request.url, "https://forgejo.test/api/v1/repos/maria/project/pulls/42");
      return new Response(
        encodeJson({
          number: 42,
          title: "Review target",
          body: "",
          html_url: "https://forgejo.test/maria/project/pulls/42",
          user: { login: "maria" },
          state: "open",
          merged: false,
          head: { ref: "feature", sha: "head", repo: null },
          base: { ref: "main", sha: "base", repo: null },
          created_at: "2026-09-13T00:00:00Z",
          updated_at: "2026-09-13T00:00:00Z",
          closed_at: null,
          merged_at: null,
          labels: [],
        }),
      );
    }
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(
      request.url,
      "https://forgejo.test/api/v1/repos/maria/project/pulls/42/reviews",
    );
    assert.deepStrictEqual(JSON.parse(await request.text()), {
      event: "COMMENT",
      body: "Review summary",
      commit_id: "head",
      comments: [],
    });
    return new Response('{"id":1}', { status: 200 });
  };
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const detail = yield* provider.getChangeRequest({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      number: 42,
    });
    assert.deepStrictEqual(detail.linkedIssues, []);
    yield* provider.submitReview({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      number: 42,
      verdict: "comment",
      body: "Review summary",
      comments: [],
    });
    assert.deepStrictEqual(methods, ["GET", "GET", "GET", "GET", "GET", "GET", "POST"]);
  }).pipe(
    Effect.provideService(
      FetchHttpClient.Fetch,
      Object.assign(fetchReview, { preconnect: () => undefined }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: { "forgejo.test": { type: "Application", token: "test-token" } },
            }),
          ),
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.command === "git") {
              assert.deepStrictEqual(input.args, ["remote", "-v"]);
              return Effect.succeed(
                processOutput("origin\thttps://forgejo.test/maria/project.git (fetch)"),
              );
            }
            assert.strictEqual(input.command, "fj");
            assert.deepStrictEqual(input.args, ["--host", "https://forgejo.test", "whoami"]);
            return Effect.succeed(processOutput(""));
          },
        },
      }),
    ),
  );
});

it.effect("probes provider authentication without exposing token details", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.args[0] === "--version") {
        return Effect.succeed(processOutput(`${input.command} version test\n`));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            encodeJson({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "octocat",
                    tokenSource: "keyring",
                    gitProtocol: "ssh",
                  },
                ],
              },
            }),
          ),
        );
      }
      if (input.command === "glab" && input.args.join(" ") === "auth status") {
        return Effect.succeed(
          processOutput(`gitlab.com
Logged in to gitlab.com as gitlab-user
`),
        );
      }
      if (input.command === "tea" && input.args[0] === "login") {
        return Effect.succeed(
          processOutput(
            encodeJson([
              {
                name: "forgejo",
                url: "https://forgejo.example.com",
                ssh_host: "forgejo.example.com",
                user: "forgejo-user",
                valid: "true",
                default: "true",
              },
            ]),
          ),
        );
      }
      if (
        input.command === "az" &&
        input.args.join(" ") === "account show --query user.name -o tsv"
      ) {
        return Effect.succeed(processOutput("azure-user@example.com\n"));
      }
      if (input.command === "cafe" && input.args.slice(-3).join(" ") === "auth status --json") {
        return Effect.succeed(
          processOutput(
            encodeJson({ schemaVersion: 1, data: { host: "git.cafe", username: "cafe-user" } }),
          ),
        );
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const layerTest = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-source-control-auth-discovery-",
      }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      layerSourceControlProviderRegistryTest({
        process: processMock,
        bitbucket: {
          probeAuth: Effect.succeed({
            status: "authenticated",
            account: Option.some("bitbucket-user"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          }),
        },
      }),
    ),
    Layer.provide(SourceControlBuiltInDrivers.layer),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        auth: item.auth.status,
        account: item.auth.account,
        detail: item.auth.detail,
      })),
      [
        {
          kind: SourceControlProviderKind.make("github"),
          auth: "authenticated",
          account: Option.some("octocat"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("gitlab"),
          auth: "authenticated",
          account: Option.some("gitlab-user"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("gitcafe"),
          auth: "authenticated",
          account: Option.some("cafe-user"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("forgejo"),
          auth: "authenticated",
          account: Option.some("forgejo-user"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("bitbucket"),
          auth: "unauthenticated",
          account: Option.none(),
          detail: Option.some(
            "Add a Bitbucket token in Settings → Source Control, or set the T3CODE_BITBUCKET_* environment variables on the server.",
          ),
        },
        {
          kind: SourceControlProviderKind.make("azure-devops"),
          auth: "authenticated",
          account: Option.some("azure-user@example.com"),
          detail: Option.none(),
        },
      ],
    );
  }).pipe(Effect.provide(layerTest));
});

it.effect(
  "checks out fj pull refs and preserves existing branches and dirty files until forced",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* VcsProcess.VcsProcess;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fj-checkout-" });
      const source = path.join(root, "source");
      const cwd = path.join(root, "checkout");
      yield* fs.makeDirectory(source);
      for (const args of [
        ["init", "-b", "main"],
        ["config", "core.autocrlf", "false"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.com"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      yield* fs.writeFileString(path.join(source, "base.txt"), "base\n");
      for (const args of [
        ["add", "base.txt"],
        ["commit", "-m", "base"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      const base = (yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: source,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: root,
        args: ["clone", "-c", "core.autocrlf=false", source, cwd],
      });
      yield* fs.writeFileString(path.join(source, "feature.txt"), "pull request change\n");
      for (const args of [
        ["add", "feature.txt"],
        ["commit", "-m", "feature"],
        ["update-ref", "refs/pull/42/head", "HEAD"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      const head = (yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: source,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      const fetched: string[] = [];
      const host = yield* SourceControlHost.SourceControlHost;
      const provider = yield* ForgejoSourceControlProvider.make.pipe(
        Effect.provideService(
          SourceControlHost.SourceControlHost,
          SourceControlHost.SourceControlHost.of({
            settings: host.settings,
            git: host.git,
            process: {
              run: (input) => {
                if (input.args[0] !== "fetch") return git.run(input);
                const url = input.args[2];
                assert.isDefined(url);
                fetched.push(url!);
                return git.run({
                  ...input,
                  args: input.args.map((arg) =>
                    arg === "git@forgejo.test:reviewer/project.git" ? source : arg,
                  ),
                });
              },
            },
          }),
        ),
        Effect.provide(
          Layer.mock(ForgejoCli.ForgejoCli)({
            resolveRepository: () =>
              Effect.succeed({
                command: "fj",
                login: "work",
                repository: "reviewer/project",
                baseUrl: "https://forgejo.test",
              }),
            api: (input) => {
              assert.include(
                ["repos/reviewer/project", "repos/reviewer/project/pulls/42"],
                input.path,
              );
              return Effect.succeed(
                processOutput(
                  encodeJson(
                    input.path.endsWith("/pulls/42")
                      ? {
                          number: 42,
                          title: "Checkout",
                          html_url: "https://forgejo.test/reviewer/project/pulls/42",
                          state: "open",
                          merged: false,
                          base: { ref: "main", sha: base, repo: null },
                          head: { ref: "feature", sha: head, repo: null },
                        }
                      : {
                          full_name: "reviewer/project",
                          clone_url: source,
                          ssh_url: "git@forgejo.test:reviewer/project.git",
                          default_branch: "main",
                        },
                  ),
                ),
              );
            },
          }),
        ),
      );
      yield* provider.checkoutChangeRequest({
        cwd,
        reference: "https://forgejo.test/reviewer/project/pulls/42",
      });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["branch", "--show-current"],
        })).stdout.trim(),
        "pulls/42",
      );
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        head,
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "feature.txt")),
        "pull request change\n",
      );
      for (const args of [
        ["checkout", "main"],
        ["branch", "-f", "pulls/42", "main"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd, args });
      yield* fs.writeFileString(path.join(cwd, "base.txt"), "uncommitted work\n");
      yield* provider.checkoutChangeRequest({ cwd, reference: "42" });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        base,
      );
      assert.strictEqual(yield* fs.exists(path.join(cwd, "feature.txt")), false);
      yield* provider.checkoutChangeRequest({
        cwd,
        reference: "42",
        force: true,
        context: {
          provider: {
            kind: SourceControlProviderKind.make("forgejo"),
            name: "Forgejo",
            baseUrl: "https://forgejo.test",
          },
          remoteName: "origin",
          remoteUrl: "git@forgejo.test:maria/project.git",
        },
      });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        head,
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "base.txt")),
        "uncommitted work\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "feature.txt")),
        "pull request change\n",
      );
      assert.deepStrictEqual(fetched, [source, source, "git@forgejo.test:reviewer/project.git"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSourceControlHost.layer.pipe(
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provideMerge(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provideMerge(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

const kind = SourceControlProviderKind.make;

// Serves both the host's runs and the server's own VCS probes, whose inputs share these fields.
const run = (
  input: Pick<
    SourceControlHost.SourceControlProcessInput,
    "operation" | "command" | "args" | "cwd"
  >,
): Effect.Effect<SourceControlHost.SourceControlProcessOutput, VcsProcessSpawnError> => {
  if (input.args[0] === "--version") {
    return input.command === "missing-cli"
      ? Effect.fail(
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause: new Error(`${input.command} not found`),
          }),
        )
      : Effect.succeed(TestSourceControlHost.processOutput(`${input.command} version test\n`));
  }
  return Effect.succeed(
    TestSourceControlHost.processOutput(`signed in as ${input.command}-user\n`),
  );
};

const cliDiscovery = (name: string) => ({
  type: "cli" as const,
  kind: kind(name),
  label: name,
  installHint: `Install ${name}.`,
  executable: name === "beta" ? "missing-cli" : `${name}-cli`,
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: ({ stdout }: { readonly stdout: string }) =>
    providerAuth({ status: "authenticated", account: /as (\S+)/.exec(stdout)?.[1] }),
});

const layerDiscovery = Layer.effect(
  SourceControlProviderRegistry.SourceControlProviderRegistry,
  SourceControlProviderRegistry.makeWithProviders(
    [
      cliDiscovery("alpha"),
      cliDiscovery("beta"),
      fakeDiscovery("gamma", {
        probeAuth: Effect.succeed(providerAuth({ status: "authenticated", account: "api-user" })),
      }),
    ].map((discovery) => ({
      kind: discovery.kind,
      provider: fakeSourceControlProvider(discovery.kind),
      discovery,
    })),
  ),
).pipe(
  Layer.provideMerge(TestSourceControlHost.layer({ process: { run } })),
  Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
  Layer.provideMerge(Layer.mock(VcsProcess.VcsProcess)({ run })),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reports every hosting integration in registry order with its sign-in", () =>
  Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        version: item.version,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: kind("alpha"),
          status: "available",
          version: Option.some("alpha-cli version test"),
          auth: "authenticated",
          account: Option.some("alpha-cli-user"),
        },
        {
          kind: kind("beta"),
          status: "missing",
          version: Option.none(),
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: kind("gamma"),
          status: "available",
          version: Option.none(),
          auth: "authenticated",
          account: Option.some("api-user"),
        },
      ],
    );
    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => [item.kind, item.status]),
      [
        ["git", "available"],
        ["jj", "available"],
      ],
    );
  }).pipe(Effect.provide(SourceControlDiscovery.layer.pipe(Layer.provide(layerDiscovery)))),
);
