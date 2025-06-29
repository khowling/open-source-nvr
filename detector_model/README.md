
# Get our model

The `detector` app can be lauched by the server to analyse objects from the images the cameras are streaming, this app needs a model, and this README goes into how to get a model.


The Yolo11 models are what we are going to base this on 
https://docs.ultralytics.com/tasks/detect/


## Lets get it (running on WSL)

### Need Python
python3 -m venv venv
source venv/bin/activate

### Installs 'yolo' CLI
```
python3 -m pip install ultralytics
```
https://docs.ultralytics.com/integrations/onnx/#exporting-yolo11-models-to-onnx

```
yolo export model=yolo11n.pt format=onnx imgsz=1280
```

WAIT: Dont use this, the outputs have been amended, see https://github.com/airockchip/rknn_model_zoo/tree/main/examples/yolo11#3-pretrained-model


Lets test it

```
yolo predict model=yolo11n.onnx source=./image150519558.jpg
```

### ROCK 5B

We need a rknn version of the model, for this, we need a conversion tool offered by https://github.com/airockchip/rknn_model_zoo

python3 convert.py ../model/yolo11n.onnx rk3588

```error
E RKNN: [22:39:58.201] REGTASK: The bit width of field value exceeds the limit, target: v2, offset: 0x4038, shift = 0, limit: 0x1fff, value: 0x419f
E RKNN: [22:39:58.201] REGTASK: The bit width of field value exceeds the limit, target: v2, offset: 0x4038, shift = 16, limit: 0x1fff, value: 0x419f
```

scp ../model/yolo11.rknn kehowli@rock-5b:~/open-source-nvr/detector/model/yolo11_1280.rknn

### On rock-5b
python3 detect.py --model_path ./model/yolo11n.rknn --target rk3588

