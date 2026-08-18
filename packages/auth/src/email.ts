export type VerificationMessage = {
  to: string;
  url: string;
};

export type EmailDelivery = {
  send: (message: VerificationMessage) => Promise<void>;
};

export function createMemoryInbox(): {
  messages: VerificationMessage[];
  delivery: EmailDelivery;
} {
  const messages: VerificationMessage[] = [];
  return {
    messages,
    delivery: {
      async send(message) {
        messages.push(message);
      },
    },
  };
}

export function createEmailDelivery(options: {
  nodeEnv: string;
  mode?: string;
}): EmailDelivery {
  const mode =
    options.mode ?? (options.nodeEnv === "production" ? "unset" : "file");

  if (options.nodeEnv === "production" && mode !== "resend") {
    return {
      async send() {
        throw new Error(
          "Email delivery is not configured for production. Configure Resend in the email phase.",
        );
      },
    };
  }

  if (mode === "memory") {
    throw new Error("Use createMemoryInbox() for AUTH_EMAIL_MODE=memory.");
  }

  if (mode === "log") {
    return {
      async send(message) {
        console.info("auth.verification_email", { to: message.to });
      },
    };
  }

  if (mode === "file") {
    return {
      async send(message) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(".local", { recursive: true });
        await writeFile(
          ".local/verification-url.txt",
          `${message.to}\n${message.url}\n`,
          "utf8",
        );
      },
    };
  }

  throw new Error(`Unsupported AUTH_EMAIL_MODE: ${mode}`);
}
