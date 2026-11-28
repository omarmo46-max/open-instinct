export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Until a real mail transport is configured, codes are written to the server log. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: (m: string) => void = console.log) {}
  async send(to: string, subject: string, text: string): Promise<void> {
    this.log(`[mail to ${to}] ${subject}\n${text}`);
  }
}
