


# Important requirements for developing the server side application

## Overall guiding principles

- Preference on functional programming, minimize any unnecessary boilerplate of abstraction that makes the code more complex to understand, but, if a function can be made more multi-purpose, then parameter-driven behaver is preferred rather than replicating identity code.
- Will be using a minimum of Node 22, and the latest typescript, prefer to use new language features in these versions where sensible.  Including using new module systems.
- Typescript Classes can be used, only where is makes a lot of sense, no unnecessary separation.  I don't want any dependency injection
- Preference on using control loops to implement the desired state of the application, for reliability & consistency.
- If there is a requirement for a queue based async processing system, i want to keep this simple, using a pointer based system, where the calling system will indicate work by creating or updating a record on a time ordered table or log, and the processing system will simply be triggered by the control loop that will check to see if there is any more work to do, if so it will do the work and increment the pointer until there is nothing left to do, and a trigger system to ensure if we know we need to trigger work, and the pointer based system isn't already processing, it will trigger it early rather than waiting for the next control loop to trigger.
- Any state information that needs to be persisted across server-restarts for reliability needs to go in the database.  The database is very fast and easy to use.  Any state that represents the forked processes or anything that will be reset when the program re-starts can be in memory, but name the variables so its clear these are in memory


##  Target `./server` app structure


Each major program components should be separated in its own file, for example
- `www.ts` has the web apis
- `sse-manager.ts` has the SSE
- `disk-check.ts` has all the disk cleaning logic
- `processor.ts` has all the control logic

there can be a utils files that have helper functions if it makes the files easer to read/maintain

## Processor logic

There should be a single control loop, that will be ran ever second the calls the following functions that are described below.

Each function can have have entry-criteria checked before running. I'd like these checks to be implemented clearly so the code will be easy to maintain.


Control Loop Functions
- `controllerDetector()` - Manages ML detection process lifecycle (starts/stops Python detector)
- Run Per-camera
    - `controllerFFmpeg` - starts/stops ffmpeg streaming process is in the appropriate desired state for each camera
      - entry-criteria:  function isn't already running from previous loops, if it is, skip

    - `controllerFFmpegConfirmation` - this function is to ensure ffmpeg is running successfullly, and generating the expected output.  if its not, indicate for ffmpeg to be restarted, that will be implemented in `controllerFFmpeg`
        - is successful, update canera status to successfulllyConfirmed (state can be in memory)
        - entry-criteria:  function isn't already running from previous loops, & ffmpeg is suppose to be running, and only run the first time ffmpeg is started, and then every 5seconds
        


    - `detectCameraMovement` - if configured, detects movement from the cameras api & updates the movement database appropriate given the rules, and constructs the playlist file for that movement.
        - entry-criteria:
            - only run if the configured interval has elapsed, not on every loop (state can be in memory) 
            - onlu run if `secMovementStartupDelay` after ffmpeg has been started or re-started & the been successfully confirme to prevent false detections during stream startup

    - `triggerProcessMovement` - if function will look to see if it has new movements to process, based on its processMovementPointer (the key of the movementdb where its currently processing) , if it has it will start a ffmpeg process using the playlist file from the movementdb entry, and process its output and send the frame information to the oML detection process, that inturn will update the movement with the objects, and move the pointer to this movement. when ffmpeg exits, it will close the movement, and check to see if there is another movment to process.
        - entry-criteria:  function isn't already running from previous loops, if it is, skip.  



- `sseKeepAlive` - if clients are connected, send a keepalive
    - entry-criteria:
        - only run at 30second intervals (every 30th loop), not on every loop (state can be in memory) 

- `clearDownDisk` - - Removes old recordings when disk usage exceeds threshold
    - entry-criteria:
        - only run at configured interval seconds, not on every loop (state can be in memory) 




## Details on the `triggerProcessMovement`


I  what to ensure that we don't have any unnecessary delays, for example if the camera api detects a movement, it should also attempt to run triggerprocessMovement using the same call as in the main loop, so it does  not wait for the next periodic check (controller). 


Some processes have effectively pipes so that the output of one process is fed into another process. For example the output of the ffmpeg frames capture process is piped through a filter to only capture the required frame data, then piped into the stdin of the image processing process that detects motion in the frames, then, in-turn is then piped into a process that updates the movement database with the accumulated movement information. 



## Database Connections

Maintain state in the following databases:
- `cameradb` - Camera configurations 
- `settingsdb` - System settings 
- `movementdb` - Movement events - the key is time-based, based on the movement time detected