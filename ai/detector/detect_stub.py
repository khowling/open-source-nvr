#!/usr/bin/env python3
"""
Simple ML detector stub for testing.
Reads image paths from stdin and outputs JSON detection results without
actually running inference.
"""

import sys
import json

def main():
    try:
        for line in sys.stdin:
            img_path = line.strip()
            if not img_path:
                continue
            
            # Return a simple detection result
            result = {
                "image": img_path,
                "detections": [
                    {
                        "object": "test_object",
                        "box": [100, 100, 200, 200],
                        "probability": 0.95
                    }
                ]
            }
            print(json.dumps(result))
            sys.stdout.flush()
    
    except KeyboardInterrupt:
        pass
    except EOFError:
        pass

if __name__ == '__main__':
    main()
