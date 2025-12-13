//import logo from './logo.svg';
import './App.css';
import React, { useEffect }  from 'react';
import Hls from 'hls.js'
import { PanelSettings } from './PanelSettings.jsx'
import { ToolbarGroup, Badge, Text, Button, Portal, Toolbar, Menu, MenuTrigger, Tooltip, SplitButton, MenuPopover, MenuList, MenuItem, ToolbarButton, ToolbarDivider, createTableColumn, TableCellLayout, Spinner, tokens, Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions } from "@fluentui/react-components";
import {
  DataGridBody,
  DataGrid,
  DataGridRow,
  DataGridHeader,
  DataGridCell,
  DataGridHeaderCell,
} from "@fluentui-contrib/react-data-grid-react-window";
import { ArrowMove20Regular, AccessibilityCheckmark20Regular, AccessTime20Regular, Settings16Regular, ArrowDownload16Regular, DataUsageSettings20Regular, Tv16Regular, Video20Regular, VideoAdd20Regular, ArrowRepeatAll20Regular, Filter20Regular, MoreVertical20Regular } from "@fluentui/react-icons";


export const VideoJS = ({options, onReady, play}) => {
  const videoRef = React.useRef(null);
  const hlsRef = React.useRef(null);
  const [isLive, setIsLive] = React.useState(false);

  React.useEffect(() => {
    const video = videoRef.current;

    if (!video) return;

    // Initialize hls.js if supported
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        liveSyncDuration: 3,
        liveMaxLatencyDuration: 10
      });
      
      hlsRef.current = hls;
      hls.attachMedia(video);
      
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log('HLS: media attached');
        onReady && onReady(video, hls);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        console.log('HLS: manifest parsed', data);
        // Detect if this is a live stream
        const isLiveStream = !data.levels[0]?.details?.live === false;
        setIsLive(isLiveStream);
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('HLS: fatal network error, trying to recover...');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('HLS: fatal media error, trying to recover...');
              hls.recoverMediaError();
              break;
            default:
              console.error('HLS: fatal error, cannot recover', data);
              hls.destroy();
              break;
          }
        }
      });

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      console.log('HLS: using native support');
      onReady && onReady(video, null);
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [onReady]);

  // Handle play changes
  React.useEffect(() => {
    if (!play) return;

    const { cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement, segments_post_movement } = play;
    const video = videoRef.current;
    const hls = hlsRef.current;

    if (!video) {
      console.warn('HLS: video element not ready yet');
      return;
    }

    const isLiveStream = !mKey; // Live streams don't have mKey
    setIsLive(isLiveStream);

    const src = `/video/${mKey ? `${mStartSegment}/${mSeconds}` : 'live'}/${cKey}/stream.m3u8${(mKey && segments_prior_to_movement) ? `?preseq=${segments_prior_to_movement}&postseq=${segments_post_movement}` : ''}`;

    if (hls) {
      hls.loadSource(src);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    }

    if (mKey && segments_prior_to_movement) {
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = segments_prior_to_movement * 2;
      }, { once: true });
    }

    console.log('HLS: play()', { isLive: isLiveStream });
    video.play().catch(e => console.warn('HLS: autoplay prevented', e));

  }, [play]);

  return (
    <div className="video-container">
      <video 
        ref={videoRef}
        controls
        autoPlay
        muted
        className={isLive ? 'live-stream' : ''}
      />
      {isLive && (
        <div style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          background: 'rgba(255, 0, 0, 0.8)',
          color: 'white',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          fontWeight: 'bold',
          pointerEvents: 'none'
        }}>
          ● LIVE
        </div>
      )}
    </div>
  );
}

function App() {

  const [currentPlaying, setCurrentPlaying] = React.useState(null)
  //const videoElement = document.getElementById("video");
  
  const playerRef = React.useRef(null);
  
  function playVideo(cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement, segments_post_movement) {
    console.log (`App() : playVideo :   cameraKey=${cKey} mKey=${mKey} (${mStartSegment}/${mSeconds}) (prior:${segments_prior_to_movement}/post:${segments_post_movement})`)
    const mPlayer = playerRef.current
    //console.log ("playVideo data: ", data)
    //const camera = cKey && data.cameras.find(c => c.key === cKey)
    if (cKey && mPlayer && (!currentPlaying || (currentPlaying.cKey !== cKey || currentPlaying.mKey !== mKey))) {

      setCurrentPlaying({ cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement, segments_post_movement})
      
      
    } else {
      console.warn(`App() : playVideo : player not ready or cannot find camera, or already playing selected camera/movement`)
    }
  }

  const handlePlayerReady = (video, hls) => {
    playerRef.current = { video, hls };

    // you can handle player events here
    video.addEventListener('waiting', () => {
      console.log('handlePlayerReady: player is waiting');
    });
  };
/*
  React.useEffect(() => {
    // make sure Video.js player is only initialized once
    if (!playerRef.current) {
      if (!videoElement) return;

      const player = playerRef.current = videojs(videoElement, { 
        autoplay: true,
        muted:"muted",
        controls: true,
        liveui: true,
      }, () => {
        console.log("player is ready");
        handlePlayerReady(player);
      });
    } else {
      // you can update player here [update player through props]
      // const player = playerRef.current;
      // player.autoplay(options.autoplay);
      // player.src(options.sources);
    }
  }, []);
*/
  return (
    <div className="container">
          <VideoJS onReady={handlePlayerReady} play={currentPlaying}/>
        <div>
          <CCTVControl playVideo={playVideo} currentPlaying={currentPlaying}/>
        </div>
      </div>
  )
  
  
}

function CCTVControl({currentPlaying, playVideo}) {

  const [panel, setPanel] = React.useState({open: false, invalidArray: []});
  const [infoDialog, setInfoDialog] = React.useState({open: false, item: null});
  const [openMenuKey, setOpenMenuKey] = React.useState(null);

  const init_data = { cameras: [], movements: [] }
  const [data, setData] = React.useState(init_data)
  
  const [mode, setMode] = React.useState('Filtered')
  const [showPlayer, setShowPlayer] = React.useState(true)
  const [highlightedKeys, setHighlightedKeys] = React.useState(new Set())

  // Use a ref to access latest config without triggering SSE reconnect
  const configRef = React.useRef(null);
  React.useEffect(() => {
    configRef.current = data.config;
  }, [data.config]);

  // Use a ref to store movements for rendering to prevent menu from closing on SSE updates
  const movementsRef = React.useRef([]);
  React.useEffect(() => {
    movementsRef.current = data.movements;
  }, [data.movements]);

  function getServerData() {
    console.log ('getServerData, mode=', mode)
    setData({...init_data, status: 'fetching'})
    fetch(`/api/movements?mode=${mode}`)
      .then(res => res.json())
      .then(
        (result) => {
          setData({...result, status: 'success'})

          console.log (`got refresh, find first streaming enabled camera & play`)
          const streamingCameras = result?.cameras.filter(c => c.enable_streaming)

          if (currentPlaying && streamingCameras.findIndex(c => c.key === currentPlaying.cKey) >= 0 && (!currentPlaying.mKey || result?.movements.findIndex(m => m.key === currentPlaying.mKey) >= 0)) {
            console.log (`we can continue playing same before refresh, because camera and/or movement is still valid`)
          } else {
            if (streamingCameras && streamingCameras.length > 0) {
              playVideo (streamingCameras[0].key)
            }
          }
        },
        // Note: it's important to handle errors here
        // instead of a catch() block so that we don't swallow
        // exceptions from actual bugs in components.
        (error) => {
          setData({...init_data, status: 'error', message: error})
          console.warn(error)
        }
      )
  }

  
  useEffect(getServerData, [mode])

  // Setup SSE connection for real-time movement updates
  useEffect(() => {
    const eventSource = new EventSource('/api/movements/stream');
    
    eventSource.onopen = () => {
      console.log('SSE connection established');
    };
    
    eventSource.onmessage = (event) => {
      try {
        const eventData = JSON.parse(event.data);
        console.log('SSE event received', eventData);
        
        // Skip non-movement events (like 'connected')
        if (!eventData.type || eventData.type === 'connected') {
          return;
        }
        
        // Helper function to check if movement should be displayed based on current mode
        const shouldDisplayMovement = (movement) => {
          if (mode === 'Movement') {
            // Show all movements in Movement mode
            return true;
          } else if (mode === 'Filtered') {
            // In Filtered mode, only show movements with tags that meet filter criteria
            const tags = movement.movement?.detection_output?.tags;
            if (!tags || tags.length === 0) {
              return false;
            }
            
            const tagFilters = configRef.current?.settings?.detection_tag_filters;
            if (!tagFilters || tagFilters.length === 0) {
              // No filters configured - hide all movements in filtered mode
              return false;
            }
            
            // Check if any tag meets its filter threshold
            return tags.some(tag => {
              const filter = tagFilters.find(f => f.tag === tag.tag);
              return filter && tag.maxProbability >= filter.minProbability;
            });
          }
          // For Time mode or any other mode, don't process SSE updates
          return false;
        };
        
        if (eventData.type === 'movement_new') {
          // Only add new movement if it should be displayed
          if (shouldDisplayMovement(eventData)) {
            setData(prevData => ({
              ...prevData,
              movements: [eventData.movement, ...prevData.movements]
            }));
            
            // Highlight the new movement
            setHighlightedKeys(prev => new Set(prev).add(eventData.movement.key));
            setTimeout(() => {
              setHighlightedKeys(prev => {
                const next = new Set(prev);
                next.delete(eventData.movement.key);
                return next;
              });
            }, 2000);
          }
        } else if (eventData.type === 'movement_update' || eventData.type === 'movement_complete') {
          setData(prevData => {
            const existingIndex = prevData.movements.findIndex(m => m.key === eventData.movement.key);
            
            if (existingIndex >= 0) {
              // Movement exists - update it if it should still be displayed
              if (shouldDisplayMovement(eventData)) {
                const updatedMovements = prevData.movements.map(m => 
                  m.key === eventData.movement.key ? eventData.movement : m
                );
                
                // Highlight the updated movement
                setHighlightedKeys(prev => new Set(prev).add(eventData.movement.key));
                setTimeout(() => {
                  setHighlightedKeys(prev => {
                    const next = new Set(prev);
                    next.delete(eventData.movement.key);
                    return next;
                  });
                }, 2000);
                
                return { ...prevData, movements: updatedMovements };
              } else {
                // Movement no longer meets filter criteria - remove it
                const filteredMovements = prevData.movements.filter(m => m.key !== eventData.movement.key);
                return { ...prevData, movements: filteredMovements };
              }
            } else {
              // Movement doesn't exist yet - add it if it should be displayed
              if (shouldDisplayMovement(eventData)) {
                // Highlight the new movement
                setHighlightedKeys(prev => new Set(prev).add(eventData.movement.key));
                setTimeout(() => {
                  setHighlightedKeys(prev => {
                    const next = new Set(prev);
                    next.delete(eventData.movement.key);
                    return next;
                  });
                }, 2000);
                
                return {
                  ...prevData,
                  movements: [eventData.movement, ...prevData.movements]
                };
              }
              return prevData;
            }
          });
        }
      } catch (err) {
        console.error('Error parsing SSE message:', err, event.data);
      }
    };
    
    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      // EventSource will automatically reconnect
    };
    
    // Cleanup on unmount
    return () => {
      console.log('Closing SSE connection');
      eventSource.close();
    };
  }, [mode]); // Only depend on mode - config changes shouldn't reconnect SSE

  
const onSelectionChange = (_, d) => {
  console.log ('onselection')
  if (d.selectedItems.size > 0) {
    const {key, movement} = data.movements.find(m => m.key === [...d.selectedItems][0])
    const { cameraKey, startSegment, seconds } = movement
    const { segments_prior_to_movement, segments_post_movement } = data.cameras.find(c => c.key === cameraKey)
    playVideo(cameraKey, key, startSegment, seconds, segments_prior_to_movement, segments_post_movement)
  }
}


  function _debug(item) {
    console.log (item)
    alert (JSON.stringify(item, null, 4))
  }

  function downloadMovement() {
    if (currentPlaying && currentPlaying.cKey && currentPlaying.mKey) {
      const c = data.cameras.find(c => c.key === currentPlaying.cKey)
      const m = data.movements.find(m => m.key === currentPlaying.mKey)
      window.open(`/mp4/${m.movement.startSegment}/${m.movement.seconds}/${m.movement.cameraKey}${(c && mode !== 'Time') ? `?preseq=${c.segments_prior_to_movement}&postseq=${c.segments_post_movement}` : ''}`, '_blank').focus()
    }
  }

  function renderTags(selectedList, idx) {
    const { key, cameraKey, detection_output, detection_status, ffmpeg } = selectedList
    const img = `/image/${key}`

    // Show results if we have them, even if still processing
    if (detection_output && detection_output.tags) {
      if (detection_output.tags.length === 0) {
        return (
          <Badge 
            appearance="tint"
            color="subtle"
            style={{ fontSize: '12px' }}
          >
            None
          </Badge>
        );
      }
      
      // Sort tags by maxProbability descending and format with percentage
      const sortedTags = [...detection_output.tags].sort((a, b) => b.maxProbability - a.maxProbability)
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
          {sortedTags.map((t, idx) => (
            <Badge 
              key={idx}
              appearance="filled"
              color="brand"
              style={{ whiteSpace: 'nowrap' }}
            >
              {t.tag} {(t.maxProbability * 100).toFixed(0)}%
            </Badge>
          ))}
        </div>
      );
    }

    // Show precise status if ML processing is ongoing and no results yet
    if (detection_status) {
      const statusMessages = {
        'starting': 'Starting',
        'extracting': 'Processing',
        'analyzing': 'Analyzing'
      };
      const message = detection_status ? statusMessages[detection_status] : 'Processing';
      
      return (
        <Badge 
          appearance="tint"
          color="warning"
          style={{ 
            fontSize: '12px',
            fontWeight: 'bold',
            padding: '4px 8px'
          }}
        >
          {message}...
        </Badge>
      )
    }
    
    // Legacy fallback for old ffmpeg data structure (if any exists)
    if (ffmpeg) {
      if (ffmpeg.success) {
        return <a key={idx} target="_blank" href={img}><Text variant="mediumPlus">Image</Text></a>
      } else {
        return <Text variant="mediumPlus">Error: {ffmpeg.stderr}</Text>
      }
    } else {
      return <Text variant="mediumPlus">please wait..</Text>
    }
  }

  return <>

      <Portal>
        <PanelSettings data={data} panel={panel} setPanel={setPanel} getServerData={getServerData}/>
      </Portal>

      <Toolbar aria-label="Default" style={{"justifyContent": "space-between" }}>

        <ToolbarGroup role="presentation">

          <ToolbarButton
            icon={<ArrowRepeatAll20Regular />}
            onClick={getServerData}
          />

          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Button 
                icon={<Tv16Regular />}
                style={{
                  ...(currentPlaying && !currentPlaying.mKey && { backgroundColor: tokens.colorNeutralBackground1Selected })
                }}
              >
                {currentPlaying ? data.cameras.find(c => c.key === currentPlaying.cKey)?.name : 'Live'}
              </Button>
            </MenuTrigger>

            <MenuPopover>
              <MenuList>
                { data.cameras.filter(c => c.enable_streaming).map(c => 
                  <MenuItem key={c.key} icon={<Video20Regular />}  onClick={() => playVideo(c.key)}>{c.name}</MenuItem>
                )}
              </MenuList>
            </MenuPopover>
          </Menu>

          <ToolbarButton

            icon={<ArrowDownload16Regular />}
            onClick={downloadMovement}
          />

          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Button  icon={<Filter20Regular />}>{mode}</Button>
            </MenuTrigger>

            <MenuPopover>
              <MenuList>
                <MenuItem key="movement" icon={<ArrowMove20Regular/>} onClick={ () => setMode ('Movement')}>All Movement</MenuItem>
                <MenuItem key="Filtered" icon={<AccessibilityCheckmark20Regular/>} onClick={ () => setMode ('Filtered')}>Filtered</MenuItem>
                <MenuItem key="Time"   icon={<AccessTime20Regular/>} onClick={ () => setMode ('Time')}>Time</MenuItem>
              </MenuList>
             </MenuPopover>
          </Menu>

        </ToolbarGroup>

        <ToolbarGroup role="presentation">
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Button  icon={<Settings16Regular />}></Button>
            </MenuTrigger>

            <MenuPopover>
              <MenuList>
                <MenuItem key="general" icon={<DataUsageSettings20Regular />}  onClick={() => {
                      setPanel({...panel, open: true, key: 'settings', invalidArray:[], heading: 'General Settings', values: { ...data.config.settings }})
                }}>General</MenuItem>

                { data.cameras.map(c => 
                  <MenuItem key={c.key} icon={<Video20Regular />}  onClick={() => {
                    setPanel({...panel, open: true, key: 'edit', invalidArray: [],  heading: `Edit Camera Details (${c.key})`, values: {
                      key: c.key,
                      name: c.name,
                      folder: c.folder,
                      disk: c.disk,
                      pollsWithoutMovement: c.pollsWithoutMovement,
                      secMaxSingleMovement: c.secMaxSingleMovement,
                      mSPollFrequency: c.mSPollFrequency,
                      segments_prior_to_movement: c.segments_prior_to_movement,
                      segments_post_movement: c.segments_post_movement,
                      enable_streaming: c.enable_streaming,
                      enable_movement: c.enable_movement,
                    }})
                  }}>{c.name}</MenuItem>
                )}

                <MenuItem key="add" icon={<VideoAdd20Regular />}  onClick={() => {
                      setPanel({...panel, open: true, key: 'new', invalidArray: [], heading: 'Add New Camera', values: {
                        pollsWithoutMovement: 0,
                        secMaxSingleMovement: 600,
                        mSPollFrequency: 1000,
                        disk: data.config.settings.disk_base_dir,
                        segments_prior_to_movement: 10, // 20 seconds (2second segments)
                        segments_post_movement: 10, // 20 seconds (2second segments)
                        enable_streaming: true,
                        enable_movement: true,
                      }})
                    }}>Add</MenuItem>
                
              </MenuList>
            </MenuPopover>
          </Menu>
        </ToolbarGroup>

      </Toolbar>

      

      <DataGrid
        size="small"
        getRowId={(item) => item.key}
        rowClassName={(item) => highlightedKeys.has(item.key) ? 'highlighted-row' : ''}
        columns={[
          createTableColumn({
            columnId: "startDate_en_GB",
            renderCell: (item) => {
              return (
                <TableCellLayout>{item.startDate_en_GB}</TableCellLayout>
              )
            }

          }),
          createTableColumn({
            columnId: "cameraName",
            renderCell: (item) => {
              return (
                <TableCellLayout>{item.cameraName}</TableCellLayout>
              )
            }

          }),
          createTableColumn({
            columnId: "seconds",
            renderCell: (item) => {
              const isProcessing = item.processing_state === 'processing' || item.processing_state === 'pending';
              const isFailed = item.processing_state === 'failed';
              return (
                <TableCellLayout>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span>{item.seconds}s</span>
                    {isProcessing && (
                      <Spinner 
                        size="extra-tiny" 
                        title={item.processing_state === 'pending' ? 'Waiting to process' : 'Processing frames'}
                      />
                    )}
                    {isFailed && (
                      <Badge 
                        appearance="filled"
                        color="danger"
                        style={{ fontSize: '11px', padding: '2px 6px' }}
                      >
                        Error
                      </Badge>
                    )}
                  </span>
                </TableCellLayout>
              )
            }

          }),
          createTableColumn({
            columnId: "tags",
            renderCell: (item) => {
              return (
                <TableCellLayout>{renderTags(item,0)}</TableCellLayout>
              )
            }

          }),
          createTableColumn({
            columnId: "actions",
            renderCell: (item) => {
              const { key, detection_output } = item;
              const img = `/image/${key}`;
              const sortedTags = detection_output?.tags ? [...detection_output.tags].sort((a, b) => b.maxProbability - a.maxProbability) : [];
              
              return (
                <TableCellLayout style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Menu 
                    positioning="below-end"
                    open={openMenuKey === key}
                    onOpenChange={(e, menuData) => setOpenMenuKey(menuData.open ? key : null)}
                  >
                    <div onClick={(e) => e.stopPropagation()}>
                      <MenuTrigger disableButtonEnhancement>
                        <Button appearance="subtle" icon={<MoreVertical20Regular />} />
                      </MenuTrigger>
                    </div>
                    <MenuPopover>
                      <MenuList>
                        <MenuItem onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuKey(null);
                          setInfoDialog({open: true, item});
                        }}>
                          Information
                        </MenuItem>
                        {sortedTags.length > 0 && sortedTags.map((t, idx) => {
                          const frameUrl = t.maxProbabilityImage 
                            ? `/frame/${key}/${t.maxProbabilityImage}`
                            : img;
                          const currentFilters = data.config.settings.detection_tag_filters || [];
                          const existingFilter = currentFilters.find(f => f.tag === t.tag);
                          
                          return (
                            <React.Fragment key={idx}>
                              <MenuItem onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuKey(null);
                                window.open(frameUrl, '_blank');
                              }}>
                                Open {t.tag} image
                              </MenuItem>
                              <MenuItem onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuKey(null);
                                if (!existingFilter) {
                                  const newFilters = [...currentFilters, { tag: t.tag, minProbability: t.maxProbability }];
                                  setPanel({...panel, open: true, key: 'settings', invalidArray:[], heading: 'General Settings', 
                                    values: { ...data.config.settings, detection_tag_filters: newFilters }})
                                } else {
                                  setPanel({...panel, open: true, key: 'settings', invalidArray:[], heading: 'General Settings', 
                                    values: { ...data.config.settings }})
                                }
                              }}>
                                {existingFilter ? `Edit ${t.tag} filter...` : `Add ${t.tag} to filter (≥${Math.round(t.maxProbability * 100)}%)`}
                              </MenuItem>
                            </React.Fragment>
                          );
                        })}
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                </TableCellLayout>
              )
            }
          })
        ]}
        items={data.movements.map(m => { 
          const camera =  data.cameras.find(c => c.key === m.movement.cameraKey)
          return  {
            key: m.key,
            ...m.movement, 
            startDate_en_GB: m.startDate_en_GB, 
            ...(camera && {  cameraName: camera.name })
          }})} 
        
          
          >

          <DataGridBody itemSize={50} height={700}>
            {({ item, rowId }, style) => {
              const isProcessing = item.processing_state === 'processing' || item.processing_state === 'pending';
              const className = isProcessing ? 'processing-row' : (highlightedKeys.has(item.key) ? 'highlighted-row' : '');
              
              return (
              <DataGridRow 
                key={rowId} 
                className={className}
                style={{ 
                  ...style, 
                  cursor: 'pointer',
                  ...(currentPlaying?.mKey === item.key && { backgroundColor: tokens.colorNeutralBackground1Selected })
                }}
                onClick={() => {
                  const { cameraKey, startSegment, seconds } = item;
                  console.log('Row clicked:', { cameraKey, startSegment, seconds, itemKey: item.key, fullItem: item });
                  const camera = data.cameras.find(c => c.key === cameraKey);
                  if (camera) {
                    if (!startSegment) {
                      console.error('startSegment is missing!', item);
                    }
                    playVideo(cameraKey, item.key, startSegment, seconds, camera.segments_prior_to_movement, camera.segments_post_movement);
                  } else {
                    console.error('Camera not found for key:', cameraKey);
                  }
                }}
              >
                {({ renderCell }) => (
                  <DataGridCell>{renderCell(item)}</DataGridCell>
                )}
              </DataGridRow>
            )}
            }
          </DataGridBody>
      </DataGrid>

      {/* Movement Information Dialog */}
      <Dialog 
        open={infoDialog.open} 
        onOpenChange={(e, data) => setInfoDialog({open: data.open, item: data.open ? infoDialog.item : null})}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Movement Information</DialogTitle>
            <DialogContent>
              {infoDialog.item && (
                <div style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Movement Key:</strong> {infoDialog.item.key}
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Camera:</strong> {infoDialog.item.cameraName}
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Camera Key:</strong> {infoDialog.item.cameraKey}
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Time:</strong> {infoDialog.item.startDate_en_GB}
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Duration:</strong> {infoDialog.item.seconds}s
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Start Segment:</strong> {infoDialog.item.startSegment}
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Processing State:</strong> {infoDialog.item.processing_state || 'N/A'}
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Detection Status:</strong> {infoDialog.item.detection_status || 'N/A'}
                  </div>
                  {infoDialog.item.detection_output?.tags && (
                    <div style={{ marginBottom: '8px' }}>
                      <strong>Detected Objects:</strong>
                      <div style={{ marginTop: '4px', paddingLeft: '12px' }}>
                        {infoDialog.item.detection_output.tags.map((t, idx) => (
                          <div key={idx}>{t.tag}: {(t.maxProbability * 100).toFixed(0)}% (count: {t.count})</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {infoDialog.item.processing_error && (
                    <div style={{ 
                      marginTop: '12px',
                      padding: '12px',
                      backgroundColor: '#fff4f4',
                      border: '1px solid #ffcccc',
                      borderRadius: '4px'
                    }}>
                      <strong style={{ color: '#d13438' }}>Error:</strong>
                      <div style={{ marginTop: '4px', color: '#333' }}>
                        {infoDialog.item.processing_error}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setInfoDialog({open: false, item: null})}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

  </>
}

export default App;
