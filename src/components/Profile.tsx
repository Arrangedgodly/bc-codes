import { useState, useEffect } from "react";
import ProfileArtist from "./ProfileArtist";
import ProfileFan from "./ProfileFan";

type ProfileProps = {
  user: any;
  fanProfile: any;
  artistProfile: any;
  setArtistProfile: any;
};

const Profile: React.FC<ProfileProps> = ({
  user,
  fanProfile,
  artistProfile,
  setArtistProfile,
}) => {
  const [page, setPage] = useState<string>("");

  const setInitialPage = () => {
    if (user?.accountType === "Fan" || user?.accountType === "Both") {
      setPage("fan");
    } else if (user?.accountType === "Artist") {
      setPage("artist");
    }
  };

  useEffect(() => {
    setInitialPage();
  }, []);

  return (
    <div className="flex flex-col items-center mt-20 min-h-[95vh] w-full">
      <h1 className="text-6xl font-bold m-5">My Profile</h1>
      <ul className="menu menu-horizontal">
        {user?.accountType !== "Fan" && (
          <li className="menu-item">
            <a
              className={
                page === "artist" ? "header-text active" : "header-text"
              }
              onClick={() => setPage("artist")}
            >
              Artist
            </a>
          </li>
        )}
        {user?.accountType !== "Artist" && (
          <li className="menu-item">
            <a
              className={page === "fan" ? "header-text active" : "header-text"}
              onClick={() => setPage("fan")}
            >
              Fan
            </a>
          </li>
        )}
      </ul>
      <div className="divider"></div>
      {page === "artist" && (
        <ProfileArtist
          artistProfile={artistProfile}
          setArtistProfile={setArtistProfile}
        />
      )}
      {page === "fan" && <ProfileFan fanProfile={fanProfile} />}
    </div>
  );
};

export default Profile;
