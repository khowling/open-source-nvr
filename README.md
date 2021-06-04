


#  Use any x86 machine as a Network Video Recorders (NVRs)

This repo contains instructions and an application to monitor your network Security Camera, record the last X hours to your computers harddrive (depending on your harddrive size), and monitor motion events through a webapp.  In addition, using your cameras motion detection to trigger a ML detection process to tag the items in the picture when the camera senses motion.  This was very useful to avoid false positives, like the sun going behind a cloud, or a rain shower.

This repo was developed with a Reolink POE camera, that provided a RTMP endpoint, and a API for motion detection.


## Install / Setup

This is a indepth process, and all pre-requsites may not be fully documented here, but techincal savvy users should be able to get this working.

### Stream your cameras output to your harddrive

Create a file called ```ffmpeg_start.sh``` that will launch a ffmpeg process that streams the video from your cameras rtmp endpoint, and saves the files to your local hardrive partition in [HLS](https://en.wikipedia.org/wiki/HTTP_Live_Streaming) segments

```
CAMERA_NAME="xxx" CAMERA_IP="xxx.xxx.0.xxx" CAMERA_PASSWD="xxx" FILEPATH="/video"
export CAMERA_NAME CAMERA_IP CAMERA_PASSWD FILEPATH
mkdir -p ${FILEPATH}/${CAMERA_NAME}

#ffmpeg -rtsp_transport tcp -i rtsp://admin:${CAMERA_PASSWD}@${CAMERA_IP}/h264Preview_01_main \
# -r 25 \
# -hide_banner -loglevel error \
# -vcodec copy \
# -start_number $(echo "$(date +%s) - 1600000000" | bc) \
# ${FILEPATH}/${CAMERA_NAME}/stream.m3u8

TOKEN=$(curl -X POST -d "[{\"cmd\":\"Login\",\"action\":0,\"param\":{\"User\":{\"userName\":\"admin\",\"password\":\"${CAMERA_PASSWD}\"}}}]" "http://${CAMERA_IP}/cgi-bin/api.cgi?cmd=Login&token=null" \
  | grep \"name\" | sed -E 's/.*"name" : "?([^,"]*)"?.*/\1/')
  
export TOKEN
ffmpeg -i "rtmp://admin:${CAMERA_PASSWD}@${CAMERA_IP}/bcs/channel0_main.bcs?token=${TOKEN}&channel=0&stream=0" \
  -r 25 \
  -hide_banner -loglevel error \
  -vcodec copy \
  -start_number $(echo "$(date +%s) - 1600000000" | bc) \
  ${FILEPATH}/${CAMERA_NAME}/stream.m3u8
```

Create a ```camera1_ffmpeg.service``` file for Linux Systemd service managers, to ensure your ffmpeg process starts when the machine starts & will be kept running

```
[Unit]
Description=camera1_ffmpeg
Wants=network-online.target
After=network-online.target

[Service]
User=xxx
Group=xxx
Type=simple
Restart=always
ExecStart=/home/xxx/ip-camera-manager/ffmpeg_start.sh

[Install]
WantedBy=multi-user.target
```

Copy the ```camera1_ffmpeg.service``` file to ```/etc/systemd/system``` , and replacing the ```xxx```

Enable & run the service

```
sudo systemctl enable  camera1_ffmpeg.service
sudo systemctl start  camera1_ffmpeg.service
```

### Build & Run Web App

Clone this repo onto a Linux machine, then: 


```
# install dependencies
npm i

# build typescript server
npm run-script buildserver

# build fromend
REACT_APP_CAMERA_NAME=mycamera npm run-script build
```

Create lauch script file called ```web.sh```
```
#!/bin/bash
BACKGROUND="true" CAMERA_NAME="xxx" CAMERA_IP="xxx.xxx.0.xxx" CAMERA_PASSWD="xxx" FILEPATH="/video" WEBPATH="/home/xxx/ip-camera-manager/build" DBPATH="/home/xxx/ip-camera-manager/mydb" node /home/xxx/ip-camera-manager/server/out/index.js

```

Create a ```camera1_web.service``` file for Linux Systemd service managers, to ensure your website starts when the machine starts & will be kept running

```
[Unit]
Description=camera1_web
Wants=network-online.target
After=network-online.target

[Service]
User=xxx
Group=xxx
Type=simple
Restart=always
ExecStart=/home/xxx/ip-camera-manager/web.sh

[Install]
WantedBy=multi-user.target
```

Copy the ```camera1_web.service``` file to ```/etc/systemd/system``` , and replacing the ```xxx```

Enable & run the service

```
sudo systemctl enable  camera1_web.service
sudo systemctl start  camera1_web.service
```

### Implemenet harddrive cleardown

To ensure your harddrive doesnt get filled up, implment the following crontab entry to delete files that is older than a specified number of minutes

```
# Every hour, delete files older than 12hrs (12 * 60mins) = 720
# 18hrs ~= 40GB
0,15,30,45 * * * * find /video -type f  -mmin +720 -exec rm {} \;
```

## Additional Systemd commands

### list services
```
systemctl --type=service
```
### list logs
```
sudo journalctl -u camera1_ffmpeg.service -f
sudo journalctl -u camera1_web.service -f
```
### stop/start/enable
```
sudo systemctl stop  camera1_web.service
```



## Create Logic Volume for the local files 

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

```
npm install --save @videojs/http-streaming
```


HTTP Live Streaming (HLS) is a widely used protocol developed by Apple that will serve your stream better to a multitude of devices. HLS will take your stream, break it into chunks, and serve it via a specialized playlist

