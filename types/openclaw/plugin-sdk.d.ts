declare module 'openclaw/plugin-sdk' {
  import type { TSchema } from '@sinclair/typebox';

  interface ToolResult {
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }

  interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute(
      toolCallId: string,
      params: unknown,
    ): Promise<ToolResult> | ToolResult;
  }

  interface CliCommand {
    command(name: string): CliCommand;
    description(desc: string): CliCommand;
    argument(name: string, desc?: string): CliCommand;
    option(flags: string, desc?: string, defaultValue?: string): CliCommand;
    action(fn: (...args: any[]) => Promise<void> | void): CliCommand;
  }

  interface ClawdbotPluginApi {
    pluginConfig: unknown;
    resolvePath(path: string): string;
    logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error?: (msg: string) => void;
    };
    registerTool(
      definition: ToolDefinition,
      opts: { name: string },
    ): void;
    registerCli(
      fn: (ctx: { program: CliCommand }) => void,
      opts: { commands: string[] },
    ): void;
    on(
      event: 'before_agent_start',
      handler: (event: {
        prompt: string;
      }) => Promise<{ prependContext?: string } | void> | void,
    ): void;
    on(
      event: 'agent_end',
      handler: (event: {
        success: boolean;
        messages: unknown[];
      }) => Promise<void> | void,
    ): void;
    registerService(service: {
      id: string;
      start: () => void;
      stop: () => void;
    }): void;
  }

  export function stringEnum<T extends readonly string[]>(
    values: T,
  ): TSchema;

  export type { ClawdbotPluginApi };
}
