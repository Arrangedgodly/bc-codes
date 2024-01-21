import { useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import {
  getUserDocument,
  updateUserName,
  updateUserLocation,
  getRelease,
} from "../firebase";
import NewRelease from "./NewRelease";
import Release from "./Release";
import RedeemedRelease from "./RedeemedRelease";

type ProfileProps = {
  user: any;
  setUser: any;
};

const Profile: React.FC<ProfileProps> = ({ user, setUser }) => {
  const navigate = useNavigate();
  const [artistName, setArtistName] = useState<string>(user?.name);
  const [newArtistName, setNewArtistName] = useState<boolean>(false);
  const [location, setLocation] = useState<string>(user?.location);
  const [newLocation, setNewLocation] = useState<boolean>(false);
  const [releases, setReleases] = useState<any[]>([]);
  const [redeemed, setRedeemed] = useState<any[]>([]);

  useEffect(() => {
    if (!user) {
      navigate("/");
    }
  }, [user]);

  const handleArtistNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setArtistName(e.target.value);
  };

  const handleArtistNameSave = async () => {
    await updateUserName(user.uid, artistName);
    setNewArtistName(false);
    setUser(await getUserDocument(user.uid));
  };

  const handleLocationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocation(e.target.value);
  };

  const handleLocationSave = async () => {
    await updateUserLocation(user.uid, location);
    setNewLocation(false);
    setUser(await getUserDocument(user.uid));
  };

  useEffect(() => {
    if (artistName !== user?.name) {
      setNewArtistName(true);
    } else {
      setNewArtistName(false);
    }
  }, [artistName]);

  useEffect(() => {
    if (location !== user?.location) {
      setNewLocation(true);
    } else {
      setNewLocation(false);
    }
  }, [location]);

  useEffect(() => {
    const fetchReleases = async () => {
      const releaseData = await Promise.all(
        user.releases.map((releaseId: string) => getRelease(releaseId))
      );
      setReleases(releaseData);
    };

    fetchReleases();
  }, [user?.releases]);

  useEffect(() => {
    const fetchRedeemed = async () => {
      const redeemedData = await Promise.all(
        user.redeemed.map(async (redeemedItem: any) => {
          const release = await getRelease(redeemedItem.releaseId);
          return { ...release, code: redeemedItem.code };
        })
      );
      setRedeemed(redeemedData);
    };

    fetchRedeemed();
  }, [user?.redeemed]);

  return (
    <div className="flex flex-col items-center mt-20 min-h-[95vh] w-full">
      <h1 className="text-6xl font-bold m-5">My Profile</h1>
      <div className="indicator m-3">
        <span className="indicator-item indicator-start badge badge-secondary text-xl">
          Artist/Label Name
        </span>
        {newArtistName && (
          <span
            className="indicator-item indicator-end indicator-bottom btn btn-info btn-sm text-xl"
            onClick={handleArtistNameSave}
          >
            Save
          </span>
        )}
        <input
          type="text"
          placeholder="Set your name"
          className="input input-bordered text-4xl input-lg text-center"
          value={artistName}
          onChange={handleArtistNameChange}
        />
      </div>
      <div className="indicator m-3">
        <span className="indicator-item indicator-start badge badge-secondary text-xl">
          Location
        </span>
        {newLocation && (
          <span
            className="indicator-item indicator-end indicator-bottom btn btn-info btn-sm text-xl"
            onClick={handleLocationSave}
          >
            Save
          </span>
        )}
        <input
          type="text"
          placeholder="Set your location"
          className="input input-bordered text-4xl input-lg text-center"
          value={location}
          onChange={handleLocationChange}
        />
      </div>
      <div className="divider"></div>
      <div className="flex items-center text-primary">
      <h2 className="text-4xl font-bold m-5">My Releases</h2>
      {releases && (
        <div className="flex items-center justify-center">
          {releases.map((release: any) => (
            <Release release={release} key={release.name} />
          ))}
        </div>
      )}
      <label htmlFor="new_release" className="btn btn-primary btn-lg text-xl">
        + New Release
      </label>
      </div>
      <NewRelease user={user} setUser={setUser} />
      <div className="divider"></div>
      {redeemed && (
        <div className="flex items-center text-accent">
          <h2 className="text-4xl font-bold m-5">My Redeemed Releases</h2>
          <div className="flex items-center justify-center">
            {redeemed.map((release: any) => (
              <RedeemedRelease release={release} key={release.name} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default Profile;
