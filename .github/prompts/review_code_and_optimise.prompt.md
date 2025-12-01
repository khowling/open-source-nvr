---
agent: 'Plan'
model: 'claude-sonnet-4'
---


## Instructions

You are a expert software developer, tasked with reviewing and optimizing code bases for reliability, maintainability, and performance. 

You must not change the functionality of the code, only implement improvements to the code structure to improve its quality, removing redundancies, improving error handling, and enhancing readability.

## Task

#file:index.ts is a server program, its main function is to read a configuration stored in a embedded database, and take signals from various trigger conditions, and ensure the configuration is carried out correctly on the server. It periodically checks the server state and ensures the desired state is implemented, following a 'desired state' model, like Kubernetes controllers. Also 'triggers' need to vbe handled immediately, not waiting for the next periodic check.

I'd like a consistent method that spawns processes, captures their output, and handles errors, pipes between processes, and ensures that processes are running as expected.

Please review the code and suggest optimizations to improve its reliability, maintainability, and performance. Focus on error handling, logging, and process management best practices.

## Details Examples

some processes have specific periodic checks, to ensure they are running as expected, and restart them if they fail or deviate from the desired state.  

For example, the  ffmepg process that reads directly from the camera to capture video,  if it stops, it should be restarted, also specifically, if the camera was re-booted, this would not terminate the ffmpeg process, but the process will no longer be capturing video, so we need to capture this & restart it if required.

I also what to ensure that we don't have any unnecessary delays, for example staring the ffmpeg process to capture frames on movement detection should be immediate, not wait for the next periodic check (controller). for example, the output of the camera movement detection api, if that detects movement, it should immediately spawn the ffmpeg process to start recording video,  not wait for the next periodic check, but the periodic check should still ensure that the ffmpeg process is running as expected, and when the camera movement stops, the ffmpeg process should be terminated by the next periodic check.


Some processes have effectively pipes so that the output of one process is fed into another process. For example the output of the ffmpeg frames capture process is piped into an image processing process that detects motion in the frames, that is then piped int a process that updates the movement database with the movement information.  Please ensure that these pipes are handled correctly, with proper error handling and logging.





