import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { type AssetResource, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";

const requested = vi.hoisted(() => [] as Array<AssetResource | null>);
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (_environmentId, resource) => {
    requested.push(resource);
    return { _tag: "Loading" };
  },
}));

function setup() {
  requested.length = 0;
}

async function renderBody(
  host: string,
  options: {
    lineBreaks?: boolean;
    repository?: string;
    text?: string;
    onOpenUrl?: (url: string) => boolean;
  } = {},
) {
  const { repository = null, text = "first line\nsecond line", onOpenUrl, ...props } = options;
  const context = {
    remarkPlugins: [],
    lineBreaks: sourceControlClients.get(host).hardLineBreaks ?? false,
    threadRef: null,
    repository,
    ...(onOpenUrl ? { onOpenUrl } : {}),
  };
  return render(
    <PullRequestMarkdownContext value={context}>
      <PullRequestMarkdown
        text={text}
        cwd="/repo"
        environmentId={EnvironmentId.make("local")}
        {...props}
      />
    </PullRequestMarkdownContext>,
  );
}

it.each(["github", "forgejo", "azure-devops"])("%s breaks a single newline", async (host) => {
  await using screen = await renderBody(host);
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(1);
});

it.each(["gitlab", "bitbucket", "gitcafe", "unknown"])(
  "%s joins a single newline",
  async (host) => {
    await using screen = await renderBody(host);
    await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
    expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
  },
);

it("lets text the host did not write opt out of the host's breaks", async () => {
  await using screen = await renderBody("github", { lineBreaks: false });
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
});

const issueUrl = "https://github.com/acme/app/issues/2";
const issueLink = `[Issue](${issueUrl})`;

it.each([
  { name: "a primary markdown click", text: issueLink, init: {}, claimed: true },
  {
    name: "a primary media-table click",
    text: `<table>\n<tr><td>\n\n${issueLink}\n\n</td><td>\n\nhttps://example.com/shot.png\n\n</td></tr>\n</table>`,
    init: {},
    claimed: true,
  },
  { name: "a control click", text: issueLink, init: { ctrlKey: true }, claimed: false },
  { name: "a command click", text: issueLink, init: { metaKey: true }, claimed: false },
])("routes $name through the appropriate link handler", async ({ text, init, claimed }) => {
  setup();
  const openedUrls: string[] = [];
  await using screen = await renderBody("github", {
    text,
    onOpenUrl: (url) => {
      openedUrls.push(url);
      return true;
    },
  });
  await expect.element(screen.getByRole("link", { name: "Issue" })).toBeInTheDocument();
  const defaultPreventedAtLink: boolean[] = [];
  const anchor = screen.getByRole("link", { name: "Issue" }).element();
  anchor.addEventListener("click", (event) => {
    defaultPreventedAtLink.push(event.defaultPrevented);
    event.preventDefault();
  });
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });

  await act(() => anchor.dispatchEvent(click));

  expect(openedUrls).toEqual(claimed ? [issueUrl] : []);
  expect(defaultPreventedAtLink).toEqual(claimed ? [] : [false]);
  expect(click.defaultPrevented).toBe(true);
});

it("loads the body's host media in the pull request's repository, not the checkout's", async () => {
  setup();
  const image = "https://github.com/user-attachments/assets/7195f963-51a9-4331-be74-3e06be760422";
  const video = "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456";
  await using _screen = await renderBody("github", {
    repository: "enterprise/private",
    text: `![shot](${image})\n\n${video}`,
  });
  await vi.waitFor(() =>
    expect(requested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cwd: "/repo",
          url: expect.stringContaining("7195f963"),
          repository: "enterprise/private",
        }),
        expect.objectContaining({
          cwd: "/repo",
          url: expect.stringContaining("2f8c1a90"),
          repository: "enterprise/private",
        }),
      ]),
    ),
  );
});
