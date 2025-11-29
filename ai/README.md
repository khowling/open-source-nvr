
# Object Detection App

This app can be lauched by the server to analyse objects from the images the cameras are streaming


## Install the Model


The `detector` app can be launched by the server to analyze objects from the images the cameras are streaming, this app needs a model, 


The Yolo11 models are what we are going to base this on 
https://docs.ultralytics.com/tasks/detect/



### Installs 'yolo' CLI
```
python3 -m pip install ultralytics
```
https://docs.ultralytics.com/integrations/onnx/#exporting-yolo11-models-to-onnx

```
yolo export model=yolo11n.pt format=onnx imgsz=1280
```


Lets test it

```
yolo predict model=yolo11n.onnx source=./image150519558.jpg
```


WAIT: The outputs have been amended, see https://github.com/airockchip/rknn_model_zoo/tree/main/examples/yolo11#3-pretrained-model,  So I've needed to modify `detect.py` to work with these ootb models, with some help from copilot.
```
Your ONNX model output has shape (1, 84, 8400), but your code expects (1, 84, h, w). This is a common YOLOv5/YOLOv8 ONNX export shape, where the last two dims are flattened (h × w = 8400).  To fix this, you need to reshape the output before passing it to `box_process`. For YOLO11, 8400 = 80×80 + 40×40 + 20×20 (for 3 detection heads). You need to reshape each branch accordingly.


Key points:
- This code assumes your ONNX model outputs a single array of shape (1, 84, 8400).
- It splits the 8400 into 3 branches: 6400 (80×80), 1600 (40×40), 400 (20×20).
- It reshapes each branch to (1, 84, h, w) before passing to `box_process`.

If your model outputs class confidences differently, you may need to adjust the `classes_conf.append(...)` line. If you need further help, print the output shapes and I can help you adapt the code.

```



## Run to develop

python3 -m detector.detect --model_path ./yolo11n.onnx --target rk3588


## Build wheel to execute
```bash
cd ai

#  We just require 'build', the rest will be installed in the venv
python3 -m pip install build 

#  This creates its own virtual environment! and creates the whl
python3 -m build

# Install the wheel, this will create the ~/.local/bin/nvr-detect script
python3 -m pip  install dist/open_source_nvr_detector-0.1.0-py3-none-any.whl

```

## Execute

```bash
nvr-detect --model_path ./model/yolo11.rknn --target rk3588
# or
nvr-detect --model_path ./model/yolo11.onnx 
```


