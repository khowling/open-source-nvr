import logo from './logo.svg';
import './App.css';
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
        src: '/video/hls_test01',
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
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          Edit <code>src/App.js</code> and save to reload.
        </p>

        <div data-vjs-player>
          <video ref={video_ref} class="vjs-default-skin" width="640" height="268" />
        </div>

        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>
    </div>
  );
}

export default App;
