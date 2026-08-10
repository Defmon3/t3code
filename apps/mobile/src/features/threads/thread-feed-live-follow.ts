export type ThreadFeedLiveFollowEvent =
  | { readonly type: "reset" }
  | { readonly type: "user-scroll-begin" }
  | {
      readonly type: "scroll";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    };

export function resolveThreadFeedLiveFollow(
  current: boolean,
  event: ThreadFeedLiveFollowEvent,
): boolean {
  switch (event.type) {
    case "reset":
      return true;
    case "user-scroll-begin":
      return false;
    case "scroll":
      if (event.isAtEnd) {
        return true;
      }
      return event.userScrollSessionActive ? false : current;
  }
}
