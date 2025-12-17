


#  Open-Source Network Video Recorder (NVR), with Object Detection

Web application to monitor your IP Security Camera network, continuously record camera feeds to your computers harddrive, and monitor motion events through a web app. Features include:

  :heavy_check_mark:  No expensive hardware required, use your old computers & harddrives \
  :heavy_check_mark:  Supports one or multiple cameras, with single, filtered, motion list \
  :heavy_check_mark:  No cloud account required, self-contained \
  :heavy_check_mark:  Enhance your Cameras motion detection with Object Detection tagging/filtering \
  :heavy_check_mark:  Continuously monitors hardrives, deleting the oldest video segments when almost full 



<p align="center">
  <img width="700"  src="./assets/wenui.png">
</p>

> **_NOTE:_** This repo was developed with Reolink POE cameras, that provided a RTMP endpoint, and a API for motion detection. But can be develoed/extended for other IP cameras

### Object Detection

In addition, if your cameras motion sensor triggers a detection, the app will take a still of the detection, and run a Object Detection process, to tag the still with the objects in the picture.  You can then use these tags to filter and review your motion events.  This is very useful to avoid false positives, like the sun going behind a cloud, or a rain shower.

<p align="center">
  <img width="450"  src="./assets/objectdetection.png">
</p>

### Settings

Using the settings menu, you first select the disk you will be using to stream real-time video from the cameras, and if you want to use the auto-deletion featre to prevent the disk from filling up, then if you want to use the object detection feature. Then you can add your cameras

<p align="center">
  <img width="250"  src="./assets/settings1a.png"> <img width="250"   src="./assets/settings2a.png"> 
</p>

<br clear="both"/>

## Repo structure

- `/server` contains the typescript api server that runs forks the ffmpeg and object detection apps, stores state in a embeded database, and provides restful apis for the react frontend.
- `/ai/detector` contains the python object detection app that uses YOLO models to detect objects in the images placed in a particular directory. 
- `/src` contains the react components that is built into the frontend browser app.

## Install / Setup / Run

The benifit of this app, its, its open-source, and it can be installed on any comodity h/w running linux (a free o/s operating system), techincal savvy users should be able to get this working.

## ROADMAP


See the [ROADMAP.md](./ROADMAP.md) for planned features and future development.


### Build & Run Web App

Ensure you have `nodejs` (recommended version >= 16 LTS), `python3`, and `ffmpeg` (latest version) installed.

Clone this repo onto a Linux machine, then build the app by running these commands: 


```
# install Node.js dependencies
npm i 

# build typescript server
npx tsc

# build frontend
npm run-script build

# install Python ML detector dependencies
cd ai
pip install -e .
cd ..
```

### To manually run the server

```
LOG_LEVEL=info node ./lib/index.js
```

Set `LOG_LEVEL` to `debug` for verbose logging, or `error` for minimal output.

Then open a browser and navigate to `http://<hostname>:8080`.  You are free to use a proxy like nginx and add TLS/DNS, authentication, then expose your app to the internet so you can monitor your home when away


## Object Detection with YOLO11n ONNX

The app includes a YOLO11n ONNX model at `./ai/model/yolo11n.onnx` for real-time object detection. To use it:

1. Install Python dependencies (see build instructions above)
2. In the settings panel, enable ML detection
3. Configure the ML model (defaults to YOLO11n)
4. Optionally set a custom frames path for extracted images
5. Configure object detection labels to filter (e.g., ignore "car" detections)

The detector will automatically run when motion is detected, tagging objects found in the frames.

### Movement Status Indicators

Each movement in the list displays a small status icon next to the duration, indicating its processing and detection state:

| Icon | Color | Meaning |
|------|-------|---------|
| 🕐 Clock | Gray | Waiting to process (pending) |
| ⏳ Spinner | Blue | Currently processing/extracting frames |
| ✓ Checkmark | Green | Detection complete (objects found) |
| ⊟ Scan | Gray | Complete, no objects detected |
| ✕ X | Red | Processing failed (hover for error details) |

Hover over any icon for a tooltip with additional details.
  

  
## To run the server each time the machine starts

Create a executable `web.sh` file containing the following (the paths need to be absolute):

```
#!/bin/bash
LOG_LEVEL=info WEBPATH="/home/<user>/open-source-nvr/build" DBPATH="/home/<user>/open-source-nvr/mydb" node /home/<user>/open-source-nvr/lib/index.js
```

Now, create a `open-source-nvr.service` file for Linux Systemd service managers, to ensure your website starts when the machine starts & will be kept running

```
[Unit]
Description=open-source-nvr
Wants=network-online.target
After=network-online.target

[Service]
User=<user>
Group=<user>
Type=simple
Environment="PATH=/usr/local/bin:/usr/bin"
WorkingDirectory=/home/<user>
ExecStart=/home/<user>/open-source-nvr/web.sh

[Install]
WantedBy=multi-user.target
```

Copy the `open-source-nvr.service` file to `/etc/systemd/system` , and replacing the `<user>`

Enable & run the service

```
sudo systemctl enable  open-source-nvr.service
sudo systemctl start  open-source-nvr.service
```


## Additional Systemd commands

### list services
```
systemctl --type=service
```
### list logs
```
sudo journalctl -u open-source-nvr.service -f
sudo journalctl -u open-source-nvr.service -n 100 --no-pager
```




## Example to create Logic Volume for the local files 

To create a logical volume from a volume group storage pool, use the ```lvcreate``` command. Specify the size of the logical volume with the -L option, specify a name with the -n option, and pass in the volume group to allocate the space from.

```
sudo lvcreate -L 40G -n video-files ubuntu-vg
```

format:
```
sudo mkfs -t ext4 /dev/mapper/ubuntu--vg-video--files
```

mount:

```
mkdir /video
sudo mount /dev/mapper/ubuntu--vg-video--files  /video
```

ensure its always mounted:
```
sudo vi /etc/fstab
/dev/mapper/ubuntu--vg-video--files /video ext4 defaults 0 0
```



## Video Format Info

The video encapsulation format used by all Reolink cameras is MP4. So the video's format we download via Reolink Client or Reolink app is MP4. But when using USB disk to backup videos directly from Reolink NVR, you could choose either H.264 or MP4 video files. - the compression type is H264


## The player

https://videojs.com/


HTTP Live Streaming (HLS) is a widely used protocol developed by Apple that will serve your stream better to a multitude of devices. HLS will take your stream, break it into chunks, and serve it via a specialized playlist


#  Program Structure


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

