export interface TestCommandDisplay {
  readonly label: string;
  readonly args: readonly string[];
}

function commandArguments(command: string): readonly string[] {
  const argumentsList: string[] = [];
  let value = "";
  let quote: '"' | "'" | null = null;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (value) {
        argumentsList.push(value);
        value = "";
      }
    } else {
      value += character;
    }
  }
  if (value) argumentsList.push(value);
  return argumentsList;
}

function executableName(argument: string | undefined): string {
  return (argument ?? "").replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function executableMatches(executable: string, names: readonly string[]): boolean {
  return names.some(
    (name) =>
      executable === name ||
      executable === `${name}.cmd` ||
      executable === `${name}.exe` ||
      executable === `${name}.ps1`,
  );
}

function verificationScriptDisplay(
  argumentsList: readonly string[],
  scriptIndex: number,
): TestCommandDisplay | null {
  const script = argumentsList[scriptIndex];
  if (!script || !isVerificationScript(script)) {
    return null;
  }
  return { label: script, args: argumentsList.slice(scriptIndex + 1) };
}

function isVerificationScript(script: string): boolean {
  const filename = executableName(script);
  return (
    filename.endsWith(".py") &&
    /(?:^|[-_.])(check|test|tests|verify|verification|mutation)(?:[-_.]|$)/i.test(filename)
  );
}

function isTestScript(argument: string | undefined): boolean {
  return /^test(?::[a-z0-9][a-z0-9:_-]*)?$/i.test(argument ?? "");
}

function unwrapShellArguments(argumentsList: readonly string[]): readonly string[] {
  const executable = executableName(argumentsList[0]);
  const shellIndex = argumentsList.findIndex(
    (argument, index) =>
      index > 0 && ["/c", "/k", "-command", "-c"].includes(argument.toLowerCase()),
  );
  const isWindowsShell = executableMatches(executable, ["cmd"]);
  const isPowerShell = executableMatches(executable, ["powershell", "pwsh"]);
  const isPosixShell = executableMatches(executable, ["sh", "bash", "zsh"]);
  if (
    shellIndex === -1 ||
    !(
      (isWindowsShell && ["/c", "/k"].includes(argumentsList[shellIndex]!.toLowerCase())) ||
      (isPowerShell && ["-command", "-c"].includes(argumentsList[shellIndex]!.toLowerCase())) ||
      (isPosixShell && argumentsList[shellIndex]!.toLowerCase() === "-c")
    )
  ) {
    return argumentsList;
  }
  const nestedArguments = argumentsList.slice(shellIndex + 1);
  return nestedArguments.length === 1 ? commandArguments(nestedArguments[0]!) : nestedArguments;
}

function packageScriptIndex(argumentsList: readonly string[]): number {
  let index = 1;
  while (index < argumentsList.length) {
    const argument = argumentsList[index]!.toLowerCase();
    if (
      argument === "--filter" ||
      argument === "-f" ||
      argument === "--workspace" ||
      argument === "-w"
    ) {
      index += 2;
      continue;
    }
    if (argument.startsWith("--filter=") || argument.startsWith("--workspace=")) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function packageTestCommand(argumentsList: readonly string[]): TestCommandDisplay | null {
  const executable = executableName(argumentsList[0]);
  if (!executableMatches(executable, ["vp", "pnpm", "npm", "yarn", "bun"])) return null;

  const scriptIndex = packageScriptIndex(argumentsList);
  const subcommand = argumentsList[scriptIndex]?.toLowerCase();
  const script = isTestScript(subcommand)
    ? argumentsList[scriptIndex]
    : subcommand === "run" && isTestScript(argumentsList[scriptIndex + 1])
      ? argumentsList[scriptIndex + 1]
      : undefined;
  if (!script) return null;

  const scriptArgumentIndex = argumentsList.indexOf(script, scriptIndex);
  return {
    label: `${executableName(argumentsList[0])} ${script}`,
    args: [...argumentsList.slice(1, scriptIndex), ...argumentsList.slice(scriptArgumentIndex + 1)],
  };
}

function runWrapperCommand(argumentsList: readonly string[]): TestCommandDisplay | null {
  const executable = executableName(argumentsList[0]);
  if (!executableMatches(executable, ["uv", "pipenv", "poetry", "rye"])) return null;
  const runIndex = argumentsList.findIndex((argument, index) => index > 0 && argument === "run");
  if (runIndex === -1) return null;
  const wrappedArguments = argumentsList.slice(runIndex + 1);
  if (wrappedArguments.length === 0) return null;
  return testCommandDisplay(wrappedArguments);
}

function testCommandDisplay(argumentsList: readonly string[]): TestCommandDisplay | null {
  const executable = executableName(argumentsList[0]);
  if (executableMatches(executable, ["vitest"]))
    return { label: "Vitest", args: argumentsList.slice(1) };
  if (executableMatches(executable, ["jest"]))
    return { label: "Jest", args: argumentsList.slice(1) };
  if (executableMatches(executable, ["pytest"]))
    return { label: "Pytest", args: argumentsList.slice(1) };
  if (executableMatches(executable, ["vstest.console"]))
    return { label: "VSTest", args: argumentsList.slice(1) };
  if (executableMatches(executable, ["dotnet-stryker"]))
    return { label: "Stryker", args: argumentsList.slice(1) };
  if (executableMatches(executable, ["node", "nodejs"])) {
    const runnerPath = argumentsList[1]?.replaceAll("\\", "/").toLowerCase() ?? "";
    return /(?:^|\/)vitest\/vitest\.mjs$/.test(runnerPath)
      ? { label: "Vitest", args: argumentsList.slice(2) }
      : null;
  }
  if (executableMatches(executable, ["vite"]))
    return argumentsList[1]?.toLowerCase() === "test"
      ? { label: "Vitest", args: argumentsList.slice(2) }
      : null;
  const packageDisplay = packageTestCommand(argumentsList);
  if (packageDisplay) return packageDisplay;
  const wrapperDisplay = runWrapperCommand(argumentsList);
  if (wrapperDisplay) return wrapperDisplay;
  if (/^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i.test(executable)) {
    if (
      argumentsList[1] === "-m" &&
      executableMatches(executableName(argumentsList[2]), ["pytest"])
    ) {
      return { label: "Pytest", args: argumentsList.slice(3) };
    }
    return verificationScriptDisplay(argumentsList, 1);
  }
  if (executableMatches(executable, ["dotnet"])) {
    const subcommand = argumentsList[1]?.toLowerCase();
    if (subcommand === "test") return { label: ".NET test", args: argumentsList.slice(2) };
    if (subcommand === "vstest") return { label: "VSTest", args: argumentsList.slice(2) };
    if (subcommand === "stryker") return { label: "Stryker", args: argumentsList.slice(2) };
    return null;
  }
  if (executableMatches(executable, ["cargo"]))
    return argumentsList[1]?.toLowerCase() === "test"
      ? { label: "Cargo test", args: argumentsList.slice(2) }
      : null;
  if (executableMatches(executable, ["go"]))
    return argumentsList[1]?.toLowerCase() === "test"
      ? { label: "Go test", args: argumentsList.slice(2) }
      : null;
  return null;
}

export function isTestCommand(command: string, argv?: readonly string[]): boolean {
  return formatTestCommand(command, argv) !== null;
}

export function formatTestCommand(
  command: string,
  argv?: readonly string[],
): TestCommandDisplay | null {
  return testCommandDisplay(unwrapShellArguments(argv ?? commandArguments(command)));
}
