export type ThreadFeedLiveFollowEvent =
  | { readonly type: "reset" }
  | { readonly type: "user-scroll-begin" }
  | { readonly type: "user-scroll-end"; readonly isAtEnd: boolean }
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
    case "user-scroll-end":
      return event.isAtEnd;
    case "scroll":
      if (event.userScrollSessionActive) {
        return false;
      }
      if (event.isAtEnd) {
        return true;
      }
      return current;
  }
}
