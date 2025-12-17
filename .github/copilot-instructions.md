

# Important requirements for developing the server side application

## Overall guiding principles

- Preference on functional programming, minimize any unnecessary boilerplate of abstraction that makes the code more complex to understand, but, if a function can be made more multi-purpose, then parameter-driven behaver is preferred rather than replicating code.
- Will be using a minimum of Node 22, and the latest typescript, prefer to use new language features in these versions where sensible.  Including using new module systems.
- Typescript Classes can be used, only where is makes a lot of sense, no unnecessary separation.  I don't want any dependency injection
- Preference on using control loops to implement the desired state of the application, for reliability & consistency.
- If there is a requirement for a queue based async processing system, i want to keep this simple, using a pointer based system, where the calling system will indicate work by creating or updating a record on a time ordered table or log, and the processing system will simply be triggered by the control loop that will check to see if there is any more work to do, if so it will do the work and increment the pointer until there is nothing left to do, and a trigger system to ensure if we know we need to trigger work, and the pointer based system isn't already processing, it will trigger it early rather than waiting for the next control loop to trigger.
- Any state information that needs to be persisted across server-restarts for reliability needs to go in the database.  The database is very fast and easy to use.  Any state that represents the forked processes or anything that will be reset when the program re-starts can be in memory, but name the variables so its clear these are in memory

