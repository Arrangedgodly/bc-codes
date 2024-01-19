import BandcampWhite from "../bc-white.png";

const date = new Date().getFullYear();

const Footer = () => {
  return (
    <div className="footer items-center bg-neutral text-neutral-content fixed bottom-0 p-2 text-lg">
      <aside>
        <p className="p-1 text-sm">
          Copyright © {date} - All rights reserved by Arranged Godly
        </p>
      </aside>
      <div className="grid-flow-col md:place-self-center md:justify-self-end">
        <a
          href="https://arrangedgodly.bandcamp.com/"
          className="btn btn-ghost btn-sm rounded-btn"
          target="_blank"
        >
          <img src={BandcampWhite} alt="bc" className="h-6 w-6" />
        </a>
      </div>
    </div>
  );
};

export default Footer;
