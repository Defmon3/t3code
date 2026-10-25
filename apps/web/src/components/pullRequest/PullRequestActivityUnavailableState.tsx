import { ActivityUnavailableState } from "../sourceControl/ActivityUnavailableState";

export function PullRequestActivityUnavailableState(props: {
  error: string;
  onRetry: () => void;
  compact?: boolean;
  term?: string;
}) {
  const { term = "pull request", ...state } = props;
  return <ActivityUnavailableState {...state} title={`Could not load ${term} activity`} />;
}
