//import logo from './logo.svg';
import './App.css';
import React, { useEffect, useMemo }  from 'react';
import Hls from 'hls.js'
import { PanelSettings } from './PanelSettings.jsx'
import { PanelStats } from './PanelStats.jsx'
import { ToolbarGroup, Badge, Text, Button, Portal, Toolbar, Menu, MenuTrigger, Tooltip, SplitButton, MenuPopover, MenuList, MenuItem, ToolbarButton, ToolbarDivider, Spinner, tokens, Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions } from "@fluentui/react-components";
import { ArrowMove20Regular, AccessibilityCheckmark20Regular, AccessTime20Regular, Settings16Regular, ArrowDownload16Regular, DataUsageSettings20Regular, Tv16Regular, Video20Regular, VideoAdd20Regular, ArrowRepeatAll20Regular, Filter20Regular, MoreVertical20Regular, Checkmark12Regular, Dismiss12Regular, Clock12Regular, Clock16Regular, ScanDash12Regular, Play20Filled, CalendarLtr16Regular, Database20Regular } from "@fluentui/react-icons";


export const VideoJS = ({options, onReady, play, imageUrl}) => {
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
      {imageUrl ? (
        <img 
          src={imageUrl} 
          alt="Detection frame"
        />
      ) : (
        <video 
          ref={videoRef}
          controls
          autoPlay
          muted
          className={isLive ? 'live-stream' : ''}
        />
      )}
      {isLive && !imageUrl && (
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
  const [displayImage, setDisplayImage] = React.useState(null)
  //const videoElement = document.getElementById("video");
  
  const playerRef = React.useRef(null);
  
  function showImage(imageUrl) {
    setDisplayImage(imageUrl);
    setCurrentPlaying(null); // Stop video when showing image
  }
  
  function playVideo(cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement, segments_post_movement) {
    setDisplayImage(null); // Clear image when playing video
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
          <VideoJS onReady={handlePlayerReady} play={currentPlaying} imageUrl={displayImage}/>
        <div>
          <CCTVControl playVideo={playVideo} currentPlaying={currentPlaying} showImage={showImage}/>
        </div>
      </div>
  )
  
  
}

/**
 * Movement Timeline Component
 * Displays movements as a scrollable vertical timeline with hour markers
 */
function MovementTimeline({ movements, cameras, currentPlaying, highlightedKeys, playVideo, showImage, setInfoDialog, config, panel, setPanel, hasMore, loadingMore, loadMoreMovements }) {
  
  // Ref for the scroll container
  const containerRef = React.useRef(null);

  // Scroll handler for infinite scroll
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Load more when scrolled to within 200px of bottom
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollHeight - scrollTop - clientHeight < 200) {
        if (hasMore && !loadingMore && loadMoreMovements) {
          loadMoreMovements();
        }
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMore, loadingMore, loadMoreMovements]);

  // Build timeline data with hour markers on the hour
  const timelineData = useMemo(() => {
    if (!movements || movements.length === 0) return [];
    
    // Prepare movement items with camera info
    const items = movements.map(m => {
      const camera = cameras?.find(c => c.key === m.movement?.cameraKey);
      return {
        key: m.key,
        startDate: parseInt(m.key),
        startDate_en_GB: m.startDate_en_GB,
        cameraName: camera?.name || 'Unknown',
        camera,
        ...m.movement
      };
    });
    
    // Sort by date descending (newest first)
    items.sort((a, b) => b.startDate - a.startDate);
    
    // Group movements by hour (on the hour)
    const hourGroups = new Map();
    let previousDayKey = null;
    
    for (const item of items) {
      const itemDate = new Date(item.startDate);
      // Create hour key representing the start of the hour
      const hourStart = new Date(itemDate.getFullYear(), itemDate.getMonth(), itemDate.getDate(), itemDate.getHours(), 0, 0);
      const hourKey = hourStart.getTime();
      const dayKey = `${itemDate.getFullYear()}-${itemDate.getMonth()}-${itemDate.getDate()}`;
      
      if (!hourGroups.has(hourKey)) {
        // Check if this is a day change
        const isDayChange = previousDayKey !== null && previousDayKey !== dayKey;
        previousDayKey = dayKey;
        
        hourGroups.set(hourKey, {
          hourKey,
          hourStart,
          isDayChange: isDayChange || hourGroups.size === 0, // First item always shows day
          movements: []
        });
      }
      
      hourGroups.get(hourKey).movements.push(item);
    }
    
    // Build result with hour markers
    const result = [];
    
    for (const [hourKey, group] of hourGroups) {
      const hourDate = group.hourStart;
      
      // Add hour marker (show day info if it's a day change or first group)
      result.push({
        type: 'hour-marker',
        key: `hour-${hourKey}`,
        date: hourDate,
        isDayChange: group.isDayChange,
        label: hourDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        dayLabel: hourDate.toLocaleDateString('en-GB', { 
          weekday: 'short',
          day: '2-digit', 
          month: 'short'
        })
      });
      
      // Add movements for this hour
      for (const item of group.movements) {
        result.push({
          type: 'movement',
          ...item
        });
      }
    }
    
    return result;
  }, [movements, cameras]);

  const handlePlayClick = (e, item) => {
    e.stopPropagation();
    const camera = cameras?.find(c => c.key === item.cameraKey);
    if (camera && item.startSegment) {
      playVideo(item.cameraKey, item.key, item.startSegment, item.seconds, camera.segments_prior_to_movement, camera.segments_post_movement);
    }
  };

  const handleBadgeClick = (e, item, tag) => {
    e.stopPropagation();
    const frameUrl = tag.maxProbabilityImage 
      ? `/frame/${item.key}/${tag.maxProbabilityImage}`
      : `/image/${item.key}`;
    showImage(frameUrl);
  };

  const handleItemClick = (item) => {
    setInfoDialog({ open: true, item });
  };

  const renderBadges = (item) => {
    const tags = item.detection_output?.tags;
    
    if (!tags || tags.length === 0) {
      // Show processing state when no tags yet
      if (item.processing_state === 'processing' || item.processing_state === 'pending') {
        return <Spinner size="extra-tiny" />;
      }
      return <Badge appearance="tint" color="subtle" style={{ fontSize: '10px' }}>No detections</Badge>;
    }
    
    // Sort and display tags
    const sortedTags = [...tags].sort((a, b) => b.maxProbability - a.maxProbability);
    
    return sortedTags.slice(0, 5).map((tag, idx) => (
      <Badge
        key={idx}
        appearance="filled"
        color="brand"
        style={{
          fontSize: '10px',
          padding: '2px 5px',
          cursor: 'pointer'
        }}
        onClick={(e) => handleBadgeClick(e, item, tag)}
      >
        {tag.tag} {(tag.maxProbability * 100).toFixed(0)}%
      </Badge>
    ));
  };

  if (timelineData.length === 0) {
    return (
      <div className="timeline-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
        <Text>No movements to display</Text>
      </div>
    );
  }

  return (
    <div className="timeline-container" ref={containerRef}>
      <div className="timeline-line" />
      
      {timelineData.map((item) => {
        if (item.type === 'hour-marker') {
          return (
            <div key={item.key} className={`timeline-hour-marker ${item.isDayChange ? 'day-change' : ''}`}>
              {item.isDayChange && (
                <span className="timeline-day-label">
                  <CalendarLtr16Regular style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                  {item.dayLabel}
                </span>
              )}
              <span className="timeline-hour-label">
                <Clock16Regular style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                {item.label}
              </span>
            </div>
          );
        }
        
        // Movement item
        const isSelected = currentPlaying?.mKey === item.key;
        const isProcessing = item.processing_state === 'processing' || item.processing_state === 'pending';
        const hasDetections = item.detection_output?.tags?.length > 0;
        const itemDate = new Date(item.startDate);
        const timeStr = itemDate.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        
        return (
          <div 
            key={item.key}
            className={`timeline-item ${isSelected ? 'selected' : ''} ${isProcessing ? 'processing' : ''} ${!hasDetections ? 'no-detection' : ''} ${highlightedKeys.has(item.key) ? 'highlighted-row' : ''}`}
            onClick={() => handleItemClick(item)}
          >
            <span className="timeline-time">{timeStr}</span>
            <span className="timeline-camera">{item.cameraName} ({item.seconds}s)</span>
            <div className="timeline-badges">
              {renderBadges(item)}
            </div>
            <Tooltip content="Play movement" relationship="label">
              <button 
                className="timeline-play-btn"
                onClick={(e) => handlePlayClick(e, item)}
                disabled={!item.startSegment}
              >
                <Play20Filled />
              </button>
            </Tooltip>
          </div>
        );
      })}
      
      {/* Loading indicator for infinite scroll */}
      {loadingMore && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', gap: '8px' }}>
          <Spinner size="tiny" />
          <Text size={200}>Loading more movements...</Text>
        </div>
      )}
      
      {/* End of list indicator */}
      {!hasMore && movements && movements.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', color: '#888' }}>
          <Text size={200}>Showing all {movements.length} movements</Text>
        </div>
      )}
    </div>
  );
}

function CCTVControl({currentPlaying, playVideo, showImage}) {

  const [panel, setPanel] = React.useState({open: false, invalidArray: []});
  const [statsOpen, setStatsOpen] = React.useState(false);
  const [infoDialog, setInfoDialog] = React.useState({open: false, item: null});
  const [openMenuKey, setOpenMenuKey] = React.useState(null);

  const init_data = { cameras: [], movements: [] }
  const [data, setData] = React.useState(init_data)
  
  const [mode, setMode] = React.useState('Filtered')
  const [showPlayer, setShowPlayer] = React.useState(true)
  const [highlightedKeys, setHighlightedKeys] = React.useState(new Set())

  // Pagination state for infinite scroll
  const [hasMore, setHasMore] = React.useState(false)
  const [nextCursor, setNextCursor] = React.useState(null)
  const [loadingMore, setLoadingMore] = React.useState(false)

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
    setHasMore(false)
    setNextCursor(null)
    fetch(`/api/movements?mode=${mode}&limit=1000`)
      .then(res => res.json())
      .then(
        (result) => {
          setData({...result, status: 'success'})
          setHasMore(result.hasMore || false)
          setNextCursor(result.nextCursor || null)

          console.log (`got refresh, find first streaming enabled camera & play, hasMore=${result.hasMore}`)
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

  // Load more movements (next page)
  function loadMoreMovements() {
    if (!hasMore || !nextCursor || loadingMore) return;
    
    console.log('loadMoreMovements, cursor=', nextCursor)
    setLoadingMore(true)
    
    fetch(`/api/movements?mode=${mode}&limit=1000&cursor=${nextCursor}`)
      .then(res => res.json())
      .then(
        (result) => {
          // Append new movements to existing ones
          setData(prev => ({
            ...prev,
            movements: [...prev.movements, ...result.movements]
          }))
          setHasMore(result.hasMore || false)
          setNextCursor(result.nextCursor || null)
          setLoadingMore(false)
          console.log(`loaded ${result.movements.length} more movements, hasMore=${result.hasMore}`)
        },
        (error) => {
          console.warn('Failed to load more movements:', error)
          setLoadingMore(false)
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

  function downloadMovement() {
    if (currentPlaying && currentPlaying.cKey && currentPlaying.mKey) {
      const c = data.cameras.find(c => c.key === currentPlaying.cKey)
      const m = data.movements.find(m => m.key === currentPlaying.mKey)
      window.open(`/mp4/${m.movement.startSegment}/${m.movement.seconds}/${m.movement.cameraKey}${(c && mode !== 'Time') ? `?preseq=${c.segments_prior_to_movement}&postseq=${c.segments_post_movement}` : ''}`, '_blank').focus()
    }
  }

  return <>

      <Portal>
        <PanelSettings data={data} panel={panel} setPanel={setPanel} getServerData={getServerData}/>
        <PanelStats open={statsOpen} onClose={() => setStatsOpen(false)} />
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
                      setPanel({...panel, open: true, key: 'settings', invalidArray:[], heading: 'General Settings', values: { ...data.config?.settings }})
                }}>General</MenuItem>

                <MenuItem key="stats" icon={<Database20Regular />} onClick={() => setStatsOpen(true)}>Stats</MenuItem>

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
                        disk: data.config?.settings?.disk_base_dir,
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

      {/* Timeline Component */}
      <MovementTimeline 
        movements={data.movements}
        cameras={data.cameras}
        currentPlaying={currentPlaying}
        highlightedKeys={highlightedKeys}
        playVideo={playVideo}
        showImage={showImage}
        setInfoDialog={setInfoDialog}
        config={data.config}
        panel={panel}
        setPanel={setPanel}
        hasMore={hasMore}
        loadingMore={loadingMore}
        loadMoreMovements={loadMoreMovements}
      />

      {/* Movement Information Dialog */}
      <Dialog 
        open={infoDialog.open} 
        onOpenChange={(e, data) => setInfoDialog({open: data.open, item: data.open ? infoDialog.item : null})}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Movement Information</DialogTitle>
            <DialogContent>
              {infoDialog.item && (() => {
                const item = infoDialog.item;
                const startTime = new Date(parseInt(item.key));
                const endTime = new Date(startTime.getTime() + (item.seconds * 1000));
                const formatTime = (d) => d.toLocaleString('en-GB', { 
                  day: '2-digit', month: '2-digit', year: 'numeric',
                  hour: '2-digit', minute: '2-digit', second: '2-digit'
                });
                const formatTimeShort = (ts) => ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'N/A';
                const camera = item.camera;
                
                // Calculate detection duration
                const detectionDuration = item.detection_started_at && item.detection_ended_at 
                  ? ((item.detection_ended_at - item.detection_started_at) / 1000).toFixed(1) + 's'
                  : item.detection_started_at && !item.detection_ended_at 
                    ? 'ongoing' 
                    : 'N/A';
                
                // Calculate processing duration
                const processingDuration = item.processing_started_at && item.processing_completed_at 
                  ? ((item.processing_completed_at - item.processing_started_at) / 1000).toFixed(1) + 's'
                  : item.processing_started_at && !item.processing_completed_at 
                    ? 'ongoing' 
                    : 'N/A';
                
                // Calculate ML average time
                const mlAvgTime = item.frames_received_from_ml && item.ml_total_processing_time_ms 
                  ? Math.round(item.ml_total_processing_time_ms / item.frames_received_from_ml) 
                  : null;
                
                const tdStyle = { padding: '3px 8px 3px 0', whiteSpace: 'nowrap', verticalAlign: 'top' };
                const sectionHeader = { padding: '10px 0 3px 0', borderTop: '1px solid #eee', marginTop: '6px' };
                
                return (
                  <div style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                      <tbody>
                        {/* Basic Info */}
                        <tr><td style={tdStyle}><strong>Movement Key:</strong></td><td style={{ padding: '3px 0' }}>{item.key}</td></tr>
                        <tr><td style={tdStyle}><strong>Camera:</strong></td><td style={{ padding: '3px 0' }}>{item.cameraName}</td></tr>
                        <tr><td style={tdStyle}><strong>Camera Key:</strong></td><td style={{ padding: '3px 0' }}>{item.cameraKey}</td></tr>
                        <tr><td style={tdStyle}><strong>Start Segment:</strong></td><td style={{ padding: '3px 0' }}>{item.startSegment}</td></tr>
                        {camera && (
                          <>
                            <tr><td style={tdStyle}><strong>Poll Frequency:</strong></td><td style={{ padding: '3px 0' }}>{camera.mSPollFrequency/1000}s</td></tr>
                            <tr><td style={tdStyle}><strong>Extend After No Movement:</strong></td><td style={{ padding: '3px 0' }}>{camera.pollsWithoutMovement} poll(s)</td></tr>
                            <tr><td style={tdStyle}><strong>Max Single Movement:</strong></td><td style={{ padding: '3px 0' }}>{camera.secMaxSingleMovement}s</td></tr>
                          </>
                        )}
                        
                        {/* Detection Section */}
                        <tr><td colSpan="2" style={sectionHeader}><strong style={{ color: '#666' }}>📹 Detection (Camera Movement)</strong></td></tr>
                        <tr><td style={tdStyle}><strong>Status:</strong></td><td style={{ padding: '3px 0' }}>{item.detection_status || (item.detection_ended_at ? 'complete' : 'detecting')}</td></tr>
                        <tr><td style={tdStyle}><strong>Start Time:</strong></td><td style={{ padding: '3px 0' }}>{formatTime(startTime)}</td></tr>
                        <tr><td style={tdStyle}><strong>End Time:</strong></td><td style={{ padding: '3px 0' }}>{item.detection_ended_at ? formatTime(new Date(item.detection_ended_at)) : 'ongoing'}</td></tr>
                        <tr><td style={tdStyle}><strong>Duration:</strong></td><td style={{ padding: '3px 0' }}>{detectionDuration}</td></tr>
                        <tr><td style={tdStyle}><strong>Poll Count:</strong></td><td style={{ padding: '3px 0' }}>{item.pollCount ?? 'N/A'}</td></tr>
                        {item.consecutivePollsWithoutMovement !== undefined && (
                          <tr><td style={tdStyle}><strong>Polls Without Movement:</strong></td><td style={{ padding: '3px 0' }}>{item.consecutivePollsWithoutMovement}</td></tr>
                        )}
                        {item.playlist_path && (
                          <tr><td style={tdStyle}><strong>Playlist:</strong></td><td style={{ padding: '3px 0', wordBreak: 'break-all' }}>{item.playlist_path}</td></tr>
                        )}
                        {item.playlist_last_segment !== undefined && (
                          <tr><td style={tdStyle}><strong>Last Segment:</strong></td><td style={{ padding: '3px 0' }}>{item.playlist_last_segment}</td></tr>
                        )}
                        
                        {/* Processing Section */}
                        <tr><td colSpan="2" style={sectionHeader}><strong style={{ color: '#666' }}>⚙️ Processing (ML Detection)</strong></td></tr>
                        <tr><td style={tdStyle}><strong>Processing State:</strong></td><td style={{ padding: '3px 0' }}>{item.processing_state || 'N/A'}</td></tr>
                        <tr><td style={tdStyle}><strong>Start Time:</strong></td><td style={{ padding: '3px 0' }}>{formatTimeShort(item.processing_started_at)}</td></tr>
                        <tr><td style={tdStyle}><strong>End Time:</strong></td><td style={{ padding: '3px 0' }}>{formatTimeShort(item.processing_completed_at)}</td></tr>
                        <tr><td style={tdStyle}><strong>Duration:</strong></td><td style={{ padding: '3px 0' }}>{processingDuration}</td></tr>
                        <tr><td style={tdStyle}><strong>Frames Sent:</strong></td><td style={{ padding: '3px 0' }}>{item.frames_sent_to_ml ?? 'N/A'}</td></tr>
                        <tr><td style={tdStyle}><strong>Frames Received:</strong></td><td style={{ padding: '3px 0' }}>{item.frames_received_from_ml ?? 'N/A'}</td></tr>
                        {mlAvgTime !== null && (
                          <>
                            <tr><td style={tdStyle}><strong>Avg ML Time:</strong></td><td style={{ padding: '3px 0' }}>{mlAvgTime}ms</td></tr>
                            <tr><td style={tdStyle}><strong>Max ML Time:</strong></td><td style={{ padding: '3px 0' }}>{item.ml_max_processing_time_ms}ms</td></tr>
                          </>
                        )}
                        
                        {/* Results Section */}
                        {item.detection_output?.tags && (
                          <>
                            <tr><td colSpan="2" style={sectionHeader}><strong style={{ color: '#666' }}>🏷️ Detected Objects</strong></td></tr>
                            <tr>
                              <td colSpan="2" style={{ padding: '3px 0' }}>
                                {item.detection_output.tags.map((t, idx) => (
                                  <div key={idx}>{t.tag}: {(t.maxProbability * 100).toFixed(0)}% (count: {t.count})</div>
                                ))}
                              </td>
                            </tr>
                          </>
                        )}
                      </tbody>
                    </table>
                    {item.processing_error && (
                      <div style={{ 
                        marginTop: '12px',
                        padding: '12px',
                        backgroundColor: '#fff4f4',
                        border: '1px solid #ffcccc',
                        borderRadius: '4px'
                      }}>
                        <strong style={{ color: '#d13438' }}>Error:</strong>
                        <div style={{ marginTop: '4px', color: '#333' }}>
                          {item.processing_error}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
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
