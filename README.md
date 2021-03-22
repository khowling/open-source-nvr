


#  Setup Linux server to capture files from ip-campera

I need to see the videos, in a browser, fast navigate, and teir to cloud

##

Run ffmpeg
```
CAMERA_NAME="xxx" CAMERA_IP="xxx.xxx.xxx.xxx" CAMERA_PASSWD="xxx" FILEPATH="/video"

mkdir -p ${FILEPATH}/${CAMERA_NAME}

ffmpeg -rtsp_transport tcp -i rtsp://xxx:${CAMERA_PASSWD}@${CAMERA_IP}/h264Preview_01_main \
 -r 25 \
 -vcodec copy \
 -start_number $(echo "$(date +%s) - 1600000000" | bc) \
 ${FILEPATH}/${CAMERA_NAME}/stream.m3u8
```
Run web
```
# install dependencies
npm i

# build typescript
npm run-script buildserver

# build fromend
REACT_APP_CAMERA_NAME=front npm run-script build

# run
CAMERA_NAME="xxx" CAMERA_IP="x.x.x.x" CAMERA_PASSWD="xxx" FILEPATH="/video" WEBPATH="/home/xxx/xxx/build" DBPATH="/home/xxx/xxx/mydb" node ./server/out/index.js

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

## Create a shell script to start ffmpeg

create a file called ```ffmpeg_start.sh```

```
#!/bin/bash


# Copy all output streams with the -c copy option, (split the video at keyframes)
# additionally map everything from input to the output with -map 0
# segment_time: segment duration to time Default value is "2" seconds (600 = 10mins). 
# reset_timestamps : allows videojs seek bar to function

ffmpeg -rtsp_transport tcp -i rtsp://admin:xxxxx@xxx.xxx.0.xxx:554/h264Preview_01_main -c copy -map 0 -f segment  -strftime 1 -segment_time 120 -reset_timestamps 1 -segment_format mp4  "static/video/mp4/out%Y-%m-%d_%H-%M-%S.mp4"
```

Copy the ```camera1_ffmpeg.service``` file to ```/etc/systemd/system``` , and replacing the xxxx

run

```
sudo systemctl enable  camera1_ffmpeg.service
```

## Video Format Info

The video encapsulation format used by all Reolink cameras is MP4. So the video's format we download via Reolink Client or Reolink app is MP4. But when using USB disk to backup videos directly from Reolink NVR, you could choose either H.264 or MP4 video files. - the compression type is H264

The Real Time Streaming Protocol (RTSP)

rtsp://server/publishing_point/file
rtsp://username:pwd@IP:port/videoMain

### images snapshot

```
http://(ip address)/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=(any combination of numbers and letters)&user=(user name)&password=(user password)
```

## The player

https://videojs.com/

```
npm install --save @videojs/http-streaming
```


HTTP Live Streaming (HLS) is a widely used protocol developed by Apple that will serve your stream better to a multitude of devices. HLS will take your stream, break it into chunks, and serve it via a specialized playlist

ffmpeg -rtsp_transport tcp -i rtsp://user:passws@<IP>:554/h264Preview_01_main -f hls ./static/video/hls/hls_preview_01_main


## Awesome

Motion detection

```
curl "http://xxxxxxxx/api.cgi?cmd=GetMdState&user=admin&password=xxxxx"
```
 1 = motion
 0 = no motion
```
[
   {
      "cmd" : "GetMdState",
      "code" : 0,
      "value" : {
         "state" : 1
      }
   }
]
```
