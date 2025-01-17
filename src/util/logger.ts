import {Container, ObjectFactory} from 'typescript-ioc';

export abstract class Logger {
  readonly info: string;
  text: string;
  abstract log(message: string, context?: any): void;
  abstract logn(message: string, context?: any): void;
  abstract debug(message: string, context?: any): void;
  abstract error(message: string, context?: any): void;
  abstract stop(): void;
}

export const logFactory: (config: {verbose?: boolean, spinner?: boolean}) => ObjectFactory = ({verbose = process.env.VERBOSE_LOGGING === 'true', spinner = process.env.LOGGING_SPINNER === 'false'}: {verbose?: boolean, spinner?: boolean}): ObjectFactory => {
  return () => {
    return new VerboseLogger();
  }
}

export const verboseLoggerFactory: (verbose?: boolean) => ObjectFactory = (verbose: boolean = process.env.VERBOSE_LOGGING === 'true') => {
  return () => {
    return new VerboseLogger(verbose);
  }
}

class VerboseLogger implements Logger {
  constructor(private verbose?: boolean) {}

  set text(text) {
    this.log(text);
  }

  get info() {
    return 'verbose logger';
  }

  log(message: string, context?: any): void {
    if (context) {
      console.log(message, context);
    } else {
      console.log(message);
    }
  }


  logn(message: string, context?: any): void {
    process.stdout.write(message);
  }

  debug(message: string, context?: any): void {
    if (!this.verbose) return;

    if (context) {
      console.log(message, context);
    } else {
      console.log(message);
    }
  }

  error(message: string, context?: any): void {
    if (!this.verbose) return;

    if (context) {
      console.error(message, context);
    } else {
      console.error(message);
    }
  }

  stop() {}
}

Container.bind(Logger).factory(verboseLoggerFactory());
