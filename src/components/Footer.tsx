import BandcampWhite from "../bc-white.png";

const date = new Date().getFullYear();

const Footer = () => {
  return (
    <div className="footer items-center bg-neutral text-neutral-content relative bottom-0 p-2 text-lg z-50 grid-cols-4">
      <aside className="items-center grid-flow-col col-span-3">
        <p className="p-1 text-sm truncate">
          Copyright © {date} - All rights reserved by CodeFanatics.app /
          Arranged Godly
        </p>
      </aside>
      <div className="grid-flow-col justify-self-end">
        <div className="tooltip tooltip-primary tooltip-left" data-tip="If you enjoy the site, please consider checking out my personal Bandcamp!">
          <a
            href="https://arrangedgodly.bandcamp.com/"
            className="btn btn-ghost btn-sm rounded-btn"
            target="_blank"
          >
            <img src={BandcampWhite} alt="bc" className="h-6 w-6" />
          </a>
        </div>
      </div>
    </div>
  );
};

export default Footer;
