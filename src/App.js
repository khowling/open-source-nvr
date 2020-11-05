//import logo from './logo.svg';
//import './App.css';
import React, { useEffect } from 'react';
import videojs from 'video.js'

function App() {

  let video_ref = React.createRef()

  useEffect(() => {
    let player
    player = videojs(video_ref.current, {
      autoplay: true,
      controls: true,
      sources: [{
        src: '/video/mp4/out-test-2020-11-05_18-30-30.mp4',
        type: 'video/mp4'
      }]
    }, function onPlayerReady() {
      console.log('onPlayerReady', this)
    })
    return function () {
      player.dispose()
    }
  })
  return (
    <div className="App">
      <header className="App-header">

        <div data-vjs-player>
          <video ref={video_ref} className="video-js vjs-default-skin" width="640" height="268" />
        </div>


      </header>
    </div>
  );
}

export default App;
