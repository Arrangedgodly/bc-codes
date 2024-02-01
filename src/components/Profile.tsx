import { useState, useEffect } from "react";
import { getArtistDocument, getFanDocument } from "../firebase";

type ProfileProps = {
  user: any;
  setUser: any;
};

const Profile: React.FC<ProfileProps> = ({ user, setUser }) => {
  const [fanProfile, setFanProfile] = useState<any>(null);
  const [artistProfile, setArtistProfile] = useState<any>(null);

  const handleProfileFetch = async () => {
    if (user?.accountType === "fan" || user?.accountType === "both") {
      const fanData = await getFanDocument(user.uid);
      setFanProfile(fanData);
    }
    if (user?.accountType === "artist" || user?.accountType === "both") {
      const artistData = await getArtistDocument(user.uid);
      setArtistProfile(artistData);
    }
  }

  useEffect(() => {
    handleProfileFetch();
  }, []);

  return (
    <div className="flex flex-col items-center mt-20 min-h-[95vh] w-full">
      <h1 className="text-6xl font-bold m-5">My Profile</h1>
      <div role='tablist' className="tabs tabs-lifted tabs-lg">
        <a className="tab tab-lifted main-text" role="tab">
          Fan
        </a>
        <a className="tab tab-lifted main-text" role="tab">
          Artist
        </a>
      </div>
      <div className="divider"></div>
      
    </div>
  );
};

export default Profile;
