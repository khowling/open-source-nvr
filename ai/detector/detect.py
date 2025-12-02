import os
import cv2
import sys
import argparse
import json

# add path
#realpath = os.path.abspath(__file__)
#_sep = os.path.sep
#realpath = realpath.split(_sep)
#sys.path.append(os.path.join(realpath[0]+_sep, *realpath[1:realpath.index('rknn_model_zoo')+1]))

from py_utils.coco_utils import COCO_test_helper
import numpy as np


OBJ_THRESH = 0.25
NMS_THRESH = 0.45

# The follew two param is for map test
# OBJ_THRESH = 0.001
# NMS_THRESH = 0.65

IMG_SIZE = (640, 640)  # (width, height), such as (1280, 736)
# IMG_SIZE = (2560, 1920)
#IMG_SIZE = (1280, 1280)

CLASSES = ("person", "bicycle", "car","motorbike ","aeroplane ","bus ","train","truck ","boat","traffic light",
           "fire hydrant","stop sign ","parking meter","bench","bird","cat","dog ","horse ","sheep","cow","elephant",
           "bear","zebra ","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball","kite",
           "baseball bat","baseball glove","skateboard","surfboard","tennis racket","bottle","wine glass","cup","fork","knife ",
           "spoon","bowl","banana","apple","sandwich","orange","broccoli","carrot","hot dog","pizza ","donut","cake","chair","sofa",
           "pottedplant","bed","diningtable","toilet ","tvmonitor","laptop	","mouse	","remote ","keyboard ","cell phone","microwave ",
           "oven ","toaster","sink","refrigerator ","book","clock","vase","scissors ","teddy bear ","hair drier", "toothbrush ")

coco_id_list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 31, 32, 33, 34,
         35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
         64, 65, 67, 70, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 84, 85, 86, 87, 88, 89, 90]


def nms_boxes(boxes, scores):
    """Suppress non-maximal boxes.
    # Returns
        keep: ndarray, index of effective boxes.
    """
    x = boxes[:, 0]
    y = boxes[:, 1]
    w = boxes[:, 2] - boxes[:, 0]
    h = boxes[:, 3] - boxes[:, 1]

    areas = w * h
    order = scores.argsort()[::-1]

    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)

        xx1 = np.maximum(x[i], x[order[1:]])
        yy1 = np.maximum(y[i], y[order[1:]])
        xx2 = np.minimum(x[i] + w[i], x[order[1:]] + w[order[1:]])
        yy2 = np.minimum(y[i] + h[i], y[order[1:]] + h[order[1:]])

        w1 = np.maximum(0.0, xx2 - xx1 + 0.00001)
        h1 = np.maximum(0.0, yy2 - yy1 + 0.00001)
        inter = w1 * h1

        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        inds = np.where(ovr <= NMS_THRESH)[0]
        order = order[inds + 1]
    keep = np.array(keep)
    return keep

def post_process(input_data):
    # YOLO11 ONNX output shape: (1, 84, 8400)
    # 84 = 4 (xywh box coords) + 80 (class scores)
    # 8400 = anchor points (80*80 + 40*40 + 20*20)
    
    output = input_data[0]  # (1, 84, 8400)
    predictions = output[0].T  # (8400, 84) - transpose to get predictions per anchor
    
    # Split into boxes and class scores
    boxes_xywh = predictions[:, :4]  # (8400, 4) - center_x, center_y, width, height
    class_scores = predictions[:, 4:]  # (8400, 80) - class probabilities
    
    # Get max class score and class index for each prediction
    class_max_scores = np.max(class_scores, axis=1)  # (8400,)
    class_ids = np.argmax(class_scores, axis=1)  # (8400,)
    
    # Filter by confidence threshold
    mask = class_max_scores >= OBJ_THRESH
    boxes_xywh = boxes_xywh[mask]
    class_max_scores = class_max_scores[mask]
    class_ids = class_ids[mask]
    
    if len(boxes_xywh) == 0:
        return None, None, None
    
    # Convert from xywh (center format) to xyxy (corner format)
    boxes_xyxy = np.zeros_like(boxes_xywh)
    boxes_xyxy[:, 0] = boxes_xywh[:, 0] - boxes_xywh[:, 2] / 2  # x1 = center_x - width/2
    boxes_xyxy[:, 1] = boxes_xywh[:, 1] - boxes_xywh[:, 3] / 2  # y1 = center_y - height/2
    boxes_xyxy[:, 2] = boxes_xywh[:, 0] + boxes_xywh[:, 2] / 2  # x2 = center_x + width/2
    boxes_xyxy[:, 3] = boxes_xywh[:, 1] + boxes_xywh[:, 3] / 2  # y2 = center_y + height/2
    
    # Apply NMS per class
    nboxes, nclasses, nscores = [], [], []
    for c in set(class_ids):
        inds = np.where(class_ids == c)[0]
        b = boxes_xyxy[inds]
        s = class_max_scores[inds]
        keep = nms_boxes(b, s)
        
        if len(keep) != 0:
            nboxes.append(b[keep])
            nclasses.append(np.full(len(keep), c))
            nscores.append(s[keep])
    
    if not nboxes:
        return None, None, None
    
    boxes = np.concatenate(nboxes)
    classes = np.concatenate(nclasses)
    scores = np.concatenate(nscores)
    
    return boxes, classes, scores


def draw(image, boxes, scores, classes):
    img_h, img_w = image.shape[:2]
    for box, score, cl in zip(boxes, scores, classes):
        left, top, right, bottom = [int(_b) for _b in box]
        
        # Clip coordinates to image boundaries for drawing (allow slight overflow)
        left = max(0, left)
        top = max(0, top)
        right = min(img_w, right)
        bottom = min(img_h, bottom)
        
        # Skip invalid boxes (empty after clipping)
        if right <= left or bottom <= top:
            continue
        
        cv2.rectangle(image, (left, top), (right, bottom), (0, 255, 0), 2)
        cv2.putText(image, '{0} {1:.2f}'.format(CLASSES[cl], score),
                    (left, max(top - 6, 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

def setup_model(args):
    model_path = args.model_path
    if model_path.endswith('.pt') or model_path.endswith('.torchscript'):
        platform = 'pytorch'
        from py_utils.pytorch_executor import Torch_model_container
        model = Torch_model_container(args.model_path)
    elif model_path.endswith('.rknn'):
        platform = 'rknn'
        from py_utils.rknn_executor import RKNN_model_container 
        model = RKNN_model_container(args.model_path, args.target, args.device_id)
    elif model_path.endswith('onnx'):
        platform = 'onnx'
        from py_utils.onnx_executor import ONNX_model_container
        model = ONNX_model_container(args.model_path)
    else:
        assert False, "{} is not rknn/pytorch/onnx model".format(model_path)
    #print('Model-{} is {} model, starting val'.format(model_path, platform))
    return model, platform

def img_check(path):
    img_type = ['.jpg', '.jpeg', '.png', '.bmp']
    for _type in img_type:
        if path.endswith(_type) or path.endswith(_type.upper()):
            return True
    return False

def main():
    """Main entry point for the detector package"""
    parser = argparse.ArgumentParser(description='Process some integers.')
    # basic params
    parser.add_argument('--model_path', type=str, required= True, help='model path, could be .pt or .rknn file')
    parser.add_argument('--target', type=str, default='rk3566', help='target RKNPU platform')
    parser.add_argument('--device_id', type=str, default=None, help='device id')
    
    parser.add_argument('--img_show', action='store_true', default=False, help='draw the result and show')
    parser.add_argument('--img_save', action='store_true', default=False, help='save the result')

    # data params
    parser.add_argument('--anno_json', type=str, default='../../../datasets/COCO/annotations/instances_val2017.json', help='coco annotation path')
    parser.add_argument('--coco_map_test', action='store_true', help='enable coco map test')

    args = parser.parse_args()

    # init model
    model, platform = setup_model(args)

    co_helper = COCO_test_helper(enable_letter_box=True)

    # run test
    img_counter = 0
    try:
        for line in sys.stdin:
            img_path = line.strip()
            if not img_path:
                continue
            
            img_name = os.path.basename(img_path)
            img_counter += 1

            if not os.path.exists(img_path):
                print("{} is not found", img_name)
                continue

            img_src = cv2.imread(img_path)
            if img_src is None:
                continue

            # Image should already be 640x640 from ffmpeg letterboxing
            img_h, img_w = img_src.shape[:2]
            img = cv2.cvtColor(img_src, cv2.COLOR_BGR2RGB)

            if platform in ['pytorch', 'onnx']:
                input_data = img.transpose((2,0,1))
                input_data = input_data.reshape(1,*input_data.shape).astype(np.float32)
                input_data = input_data/255.
            else:
                input_data = img

            outputs = model.run([input_data])

            boxes, classes, scores = post_process(outputs)

            # Prepare detection output (even if empty)
            detections = []
            
            # Handle case where objects are detected
            if boxes is not None and len(boxes) > 0:
                # Model outputs pixel coordinates in 640x640 space
                # Clip to image bounds (should already be within bounds)
                boxes[:, 0] = np.clip(boxes[:, 0], 0, img_w)  # left
                boxes[:, 1] = np.clip(boxes[:, 1], 0, img_h)  # top
                boxes[:, 2] = np.clip(boxes[:, 2], 0, img_w)  # right
                boxes[:, 3] = np.clip(boxes[:, 3], 0, img_h)  # bottom
                
                # Draw boxes on the original image
                img_annotated = img_src.copy()
                draw(img_annotated, boxes, scores, classes)
                # Overwrite the original image with annotated version
                cv2.imwrite(img_path, img_annotated)
                
                # Build detections list
                for box, score, cl in zip(boxes, scores, classes):
                    left, top, right, bottom = [int(_b) for _b in box]
                    detections.append({
                        "object": CLASSES[cl],
                        "box": [left, top, right, bottom],
                        "probability": float(score)
                    })
            
            # Always output JSON result (even with empty detections)
            result = {
                "image": img_path,
                "detections": detections
            }
            print(json.dumps(result))
            sys.stdout.flush()  # Ensure output is sent immediately
            
            if args.img_show or args.img_save:
                print('\n\nIMG: {}'.format(img_name))
                img_p = img_src.copy()
                if boxes is not None:
                    print("Image shape:", img_src.shape)
                    print("Detected boxes:", boxes[:5] if len(boxes) > 5 else boxes)
                    # No need to map boxes - they're already in correct coordinates
                    draw(img_p, boxes, scores, classes)

                if args.img_save:
                    if not os.path.exists('./result'):
                        os.mkdir('./result')
                    result_path = os.path.join('./result', img_name)
                    cv2.imwrite(result_path, img_p)
                    print('Detection result save to {}'.format(result_path))
                            
                if args.img_show:
                    cv2.imshow("full post process result", img_p)
                    cv2.waitKeyEx(0)
    
    except KeyboardInterrupt:
        print("\nExiting gracefully...")
    except EOFError:
        print("\nEnd of input reached.")
    finally:
        model.release()
        cv2.destroyAllWindows()

if __name__ == '__main__':
    main()
